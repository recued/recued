/** D-315 slice 1 — the mail-facts contract: the built-in catalog's invariants,
 *  type ids and event paths, the closed `where` vocabulary, and the template
 *  validator. Spec: D-315 §3, §4, §5.1. */

import { describe, expect, it } from 'vitest';

import {
  canonicalMailFactCarrier,
  canonicalMailFactPattern,
  canonicalMailFactText,
  mailFactStoredId,
  mailFactStoredText,
  mailTemplateDefinitionOf,
  mailTemplateReads,
  mailTemplateStarterProblems,
  mailTemplateStarters,
  MAIL_FACT_BUILTIN_TYPES,
  MAIL_TEMPLATE_LIMITS,
  MAIL_FACT_EVENT_PATTERN,
  MAIL_FACT_LAST_EMAIL_AT,
  MAIL_FACT_RESERVED_VARIABLE_NAMES,
  getMailFactBuiltinType,
  isMailFactBuiltinTypeId,
  isMailFactDataPath,
  mailFactDataAt,
  mailTemplateNarrowsPastDomain,
  isMailFactCustomTypeId,
  isMailFactTypeId,
  mailFactDefaultEntrance,
  mailFactEventPath,
  mailFactEventPattern,
  mailFactFieldKeys,
  mailFactOn,
  mailFactTypeVariables,
  mailFactWhereKeys,
  validateMailFactCustomType,
  validateMailFactTypeChange,
  validateMailTemplateDefinition,
  type MailFactTypeSpec,
  type MailTemplateDefinition,
} from '../mail-facts.js';
import { isReservedLocalRpc, MCP_RESERVED_RPC_PREFIXES, SERVER_RPC_METHODS } from '../index.js';

const shipment = getMailFactBuiltinType('shipment')!;

/** A well-formed shipment template: a sender and subject entrance, the two
 *  identity variables read by rules, the state from subject words. */
const shipmentTemplate = (over: Partial<MailTemplateDefinition> = {}): MailTemplateDefinition => ({
  name: 'UPS shipping notice',
  type: 'shipment',
  entrance: {
    conditions: [
      { field: 'from', op: 'is', value: 'pkginfo@ups.com' },
      { field: 'subject', op: 'contains', value: 'UPS Update' },
    ],
    variables: ['carrier', 'tracking_number'],
  },
  rules: [
    { target: { variable: 'carrier' }, source: 'from_name', find: { kind: 'whole' } },
    {
      target: { variable: 'tracking_number' },
      source: 'body',
      find: { kind: 'after_label', label: 'Tracking Number:' },
    },
    {
      target: { variable: 'state' },
      source: 'subject',
      find: { kind: 'keyword_map', cases: [{ contains: 'Delivered', value: 'delivered' }] },
    },
  ],
  html: false,
  ai: { enabled: false },
  ...over,
});

describe('the built-in catalog (§3.1)', () => {
  it('has the ten types of §3.1 and owner_request', () => {
    expect(MAIL_FACT_BUILTIN_TYPES.map((t) => t.id)).toEqual([
      'purchase',
      'shipment',
      'return_refund',
      'reservation',
      'bill',
      'statement',
      'subscription',
      'pay_tax_document',
      'lead',
      'order_received',
      'owner_request',
    ]);
  });

  for (const type of MAIL_FACT_BUILTIN_TYPES as readonly MailFactTypeSpec[]) {
    it(`${type.id}: identity names declared variables, and no name is reserved or repeated`, () => {
      const declared = type.variables.map((variable) => variable.name);
      expect(new Set(declared).size).toBe(declared.length);
      for (const name of declared) expect(MAIL_FACT_RESERVED_VARIABLE_NAMES.has(name)).toBe(false);
      expect(type.identity.length).toBeGreaterThan(0);
      for (const alternative of type.identity) {
        for (const name of alternative) expect(declared).toContain(name);
      }
      for (const variable of type.variables) {
        if (variable.kind === 'enum') expect((variable.values ?? []).length).toBeGreaterThan(0);
      }
      expect(type.states.length).toBeGreaterThan(0);
      expect(mailFactDefaultEntrance(type).length).toBeGreaterThan(0);
      // Its id is one segment of an event path.
      expect(type.id).toMatch(/^[a-z_]+$/);
    });
  }

  it('carries no deadline variables (ruling 35)', () => {
    const names = (MAIL_FACT_BUILTIN_TYPES as readonly MailFactTypeSpec[]).flatMap((t) =>
      t.variables.map((variable) => variable.name),
    );
    expect(names).not.toContain('return_by');
    expect(names).not.toContain('cancel_by');
  });

  it('adds state, and notice only where a type has notices', () => {
    const shipmentNames = mailFactTypeVariables(shipment).map((variable) => variable.name);
    expect(shipmentNames).toContain('state');
    expect(shipmentNames).not.toContain('notice');
    const bill = getMailFactBuiltinType('bill')!;
    const billVariables = mailFactTypeVariables(bill);
    expect(billVariables.find((variable) => variable.name === 'notice')?.values).toEqual(['reminder']);
  });

  it('defaults the entrance to the required variables', () => {
    expect(mailFactDefaultEntrance(shipment)).toEqual(['carrier', 'tracking_number']);
  });
});

describe('type ids and event paths (§4.5, §5)', () => {
  it('recognizes built-in and owner type ids', () => {
    expect(isMailFactBuiltinTypeId('shipment')).toBe(true);
    expect(isMailFactTypeId('custom_wine_club')).toBe(true);
    expect(isMailFactCustomTypeId('custom_wine_club')).toBe(true);
    // A dot would add an event-path segment; capitals and an empty slug are refused.
    for (const bad of ['custom.wine', 'Custom_wine', 'custom_', 'custom_Wine', `custom_${'a'.repeat(41)}`]) {
      expect(isMailFactTypeId(bad)).toBe(false);
    }
  });

  it('builds the event path with the type as its slug segment, and one pattern for every kind', () => {
    expect(mailFactEventPath('shipment', 'created')).toBe('data.mail_fact.shipment.thing.created');
    expect(mailFactEventPath('custom_wine_club', 'updated')).toBe(
      'data.mail_fact.custom_wine_club.thing.updated',
    );
    // A trigger on one kind hears its things; on any kind, every kind's.
    expect(mailFactEventPattern('bill')).toBe('data.mail_fact.bill.thing.*');
    expect(MAIL_FACT_EVENT_PATTERN).toBe('data.mail_fact.*.thing.*');
    expect(mailFactOn('shipment')).toBe('mail_fact.shipment');
    expect(mailFactOn(null)).toBe('mail_fact');
  });

  it('keeps the time of a thing’s newest email off any kind’s variables, and on every kind’s trigger fields (ruling 44)', () => {
    expect(MAIL_FACT_RESERVED_VARIABLE_NAMES.has(MAIL_FACT_LAST_EMAIL_AT)).toBe(true);
    for (const spec of MAIL_FACT_BUILTIN_TYPES) {
      expect(mailFactTypeVariables(spec).map((variable) => variable.name)).not.toContain(MAIL_FACT_LAST_EMAIL_AT);
      expect(mailFactFieldKeys(spec).has(MAIL_FACT_LAST_EMAIL_AT)).toBe(true);
      expect(mailFactWhereKeys(spec).has(MAIL_FACT_LAST_EMAIL_AT)).toBe(false);
    }
  });
});

describe('the closed where and fields vocabulary (§5.1)', () => {
  it('allows filterable variables, complete and template — never money, files or data', () => {
    const purchaseKeys = mailFactWhereKeys(getMailFactBuiltinType('purchase')!);
    expect(purchaseKeys.has('merchant')).toBe(true);
    expect(purchaseKeys.has('state')).toBe(true);
    expect(purchaseKeys.has('complete')).toBe(true);
    expect(purchaseKeys.has('template')).toBe(true);
    expect(purchaseKeys.has('total')).toBe(false); // money
    expect(purchaseKeys.has('items')).toBe(false); // data
    expect(mailFactWhereKeys(getMailFactBuiltinType('bill')!).has('document')).toBe(false); // file
  });

  it('lets fields name every variable', () => {
    const keys = mailFactFieldKeys(shipment);
    expect(keys.has('tracking_number')).toBe(true);
    expect(keys.has('state')).toBe(true);
    expect(keys.has('complete')).toBe(false);
  });
});

describe('validateMailTemplateDefinition (§4)', () => {
  it('accepts a well-formed template', () => {
    expect(validateMailTemplateDefinition(shipmentTemplate(), shipment)).toEqual([]);
  });

  it('refuses an unknown type', () => {
    expect(validateMailTemplateDefinition(shipmentTemplate(), undefined)[0]).toMatch(/not a known fact type/);
  });

  it('needs a rule reading each entrance variable from the email — a constant does not count', () => {
    const problems = validateMailTemplateDefinition(
      shipmentTemplate({
        rules: [
          { target: { variable: 'carrier' }, source: 'from_name', find: { kind: 'constant', value: 'UPS' } },
        ],
      }),
      shipment,
    );
    expect(problems).toContain("entrance variable 'carrier' has no rule that reads it from the email");
    expect(problems).toContain("entrance variable 'tracking_number' has no rule that reads it from the email");
  });

  it('needs at least one condition or entrance variable', () => {
    const problems = validateMailTemplateDefinition(
      shipmentTemplate({ entrance: { conditions: [], variables: [] } }),
      shipment,
    );
    expect(problems).toContain('the entrance needs at least one condition or one variable');
  });

  it('checks patterns: they compile, have one capture group, and only safe flags', () => {
    const withPattern = (pattern: string, flags?: string) =>
      validateMailTemplateDefinition(
        shipmentTemplate({
          rules: [
            ...shipmentTemplate().rules,
            {
              target: { data: 'eta_text' },
              source: 'body',
              find: flags === undefined ? { kind: 'pattern', pattern } : { kind: 'pattern', pattern, flags },
            },
          ],
        }),
        shipment,
      );
    expect(withPattern('Arriving (\\w+)')).toEqual([]);
    expect(withPattern('Arriving \\w+').join()).toMatch(/exactly one capture group \(has 0\)/);
    expect(withPattern('(a)(b)').join()).toMatch(/has 2/);
    expect(withPattern('([').join()).toMatch(/does not compile/);
    expect(withPattern('(x)', 'g').join()).toMatch(/flags other than/);
  });

  it('refuses reading HTML without html: true', () => {
    const problems = validateMailTemplateDefinition(
      shipmentTemplate({
        rules: [
          ...shipmentTemplate().rules,
          { target: { data: 'eta' }, source: 'html', find: { kind: 'whole' } },
        ],
      }),
      shipment,
    );
    expect(problems.join()).toMatch(/needs the template's html: true/);
  });

  it('picks an attachment and never reads it (ruling 25)', () => {
    const bill = getMailFactBuiltinType('bill')!;
    const billTemplate = (rule: MailTemplateDefinition['rules'][number]): MailTemplateDefinition => ({
      name: 'Power bill',
      type: 'bill',
      entrance: { conditions: [{ field: 'from', op: 'is', value: 'billing@power.example' }], variables: [] },
      rules: [rule],
      html: false,
      ai: { enabled: false },
    });
    expect(
      validateMailTemplateDefinition(
        billTemplate({
          target: { variable: 'document' },
          source: 'attachment',
          find: { kind: 'attachment', by: 'type', match: 'application/pdf' },
        }),
        bill,
      ),
    ).toEqual([]);
    expect(
      validateMailTemplateDefinition(
        billTemplate({ target: { data: 'pdf_text' }, source: 'attachment', find: { kind: 'whole' } }),
        bill,
      ).join(),
    ).toMatch(/picked, never read/);
  });

  it('never lets the AI fill an entrance variable (ruling 37), and allows identity outside it (ruling 39)', () => {
    const ai = (slots: string[]) =>
      validateMailTemplateDefinition(
        shipmentTemplate({
          entrance: {
            conditions: shipmentTemplate().entrance.conditions,
            variables: ['carrier'],
          },
          ai: { enabled: true, prompt: 'Read the parcel details.', slots, pool: 'byok_only' },
        }),
        shipment,
      );
    expect(ai(['carrier']).join()).toMatch(/entrance variable; the AI never decides whether a fact exists/);
    expect(ai(['tracking_number', 'expected_at', 'data.eta_text'])).toEqual([]);
    expect(ai(['nope']).join()).toMatch(/neither a variable/);
  });

  it("needs more than the sender's domain before the AI is on (§4.1)", () => {
    const domainOnly = (ai: MailTemplateDefinition['ai']) =>
      validateMailTemplateDefinition(
        shipmentTemplate({
          entrance: { conditions: [{ field: 'from', op: 'domain_is', value: 'amazon.com' }], variables: [] },
          ai,
        }),
        shipment,
      );
    expect(domainOnly({ enabled: false })).toEqual([]);
    expect(
      domainOnly({ enabled: true, prompt: 'Read it.', slots: ['data.note'], pool: 'free_only' }).join(),
    ).toMatch(/needs more than the sender's domain/);
  });

  // An entrance that every email of the domain meets narrows nothing: a
  // variable read WHOLE (the sender's name), a constant, or `subject matches .*`.
  it('counts only what narrows: a variable read after a label, by a pattern or keywords; a condition not every email meets', () => {
    const ai = { enabled: true as const, prompt: 'Read it.', slots: ['data.note'], pool: 'free_only' as const };
    const domain = { field: 'from' as const, op: 'domain_is' as const, value: 'amazon.com' };
    const merchantWhole = { target: { variable: 'merchant' }, source: 'from_name' as const, find: { kind: 'whole' as const } };
    const trackingLabel = { target: { variable: 'tracking_number' }, source: 'body' as const, find: { kind: 'after_label' as const, label: 'Tracking:' } };
    const problems = (entrance: MailTemplateDefinition['entrance'], rules: MailTemplateDefinition['rules']) =>
      validateMailTemplateDefinition(shipmentTemplate({ entrance, rules, ai }), shipment).join();
    expect(problems({ conditions: [domain], variables: ['merchant'] }, [merchantWhole])).toMatch(/needs more than the sender's domain/);
    expect(problems({ conditions: [domain, { field: 'subject', op: 'matches', value: '.*' }], variables: [] }, [merchantWhole]))
      .toMatch(/needs more than the sender's domain/);
    expect(problems({ conditions: [domain], variables: ['tracking_number'] }, [trackingLabel])).not.toMatch(/sender's domain/);
    expect(problems({ conditions: [domain, { field: 'subject', op: 'contains', value: 'shipped' }], variables: [] }, [merchantWhole]))
      .not.toMatch(/sender's domain/);
    expect(mailTemplateNarrowsPastDomain({ entrance: { conditions: [domain], variables: ['merchant'] }, rules: [merchantWhole] })).toBe(false);
  });

  it('refuses a data path through a prototype: an email’s text would reach every object in the server', () => {
    for (const path of ['__proto__.x', 'order.__proto__', 'constructor.prototype.x']) {
      expect(validateMailTemplateDefinition(shipmentTemplate({
        rules: [...shipmentTemplate().rules, { target: { data: path }, source: 'subject', find: { kind: 'whole' } }],
      }), shipment).join(), path).toMatch(/none of them __proto__, prototype or constructor/);
    }
    expect(validateMailTemplateDefinition(shipmentTemplate({
      ai: { enabled: true, prompt: 'Read it.', slots: ['data.__proto__.polluted'], pool: 'free_only' },
    }), shipment).join()).toMatch(/is not a data path/);
    expect(isMailFactDataPath('order.gift_note')).toBe(true);
    expect(isMailFactDataPath('__proto__')).toBe(false);
    // Reading one never finds what an object inherits.
    expect(mailFactDataAt({}, '__proto__')).toBeUndefined();
    expect(mailFactDataAt({ a: {} }, 'a.toString')).toBeUndefined();
  });

  it('refuses a repeated block that splits at an empty match, which would split everywhere', () => {
    const repeat = (split: string) => validateMailTemplateDefinition(
      shipmentTemplate({ repeat: { source: 'body', split } }), shipment,
    ).join();
    expect(repeat('x*')).toMatch(/matches an empty text/);
    expect(repeat('\\s*')).toMatch(/matches an empty text/);
    expect(repeat('Parcel \\d')).not.toMatch(/repeat/);
  });

  it('refuses a condition op that does not apply to its field', () => {
    const problems = validateMailTemplateDefinition(
      shipmentTemplate({
        entrance: {
          conditions: [{ field: 'label', op: 'contains', value: 'Shipping' }],
          variables: ['carrier', 'tracking_number'],
        },
      }),
      shipment,
    );
    expect(problems.join()).toMatch(/'contains' does not apply to label/);
  });

  it('refuses a relationship the contact graph never holds, which would match nothing', () => {
    const withRelationship = (value: string): string[] =>
      validateMailTemplateDefinition(
        shipmentTemplate({
          entrance: {
            conditions: [{ field: 'relationship', op: 'is', value }],
            variables: ['carrier', 'tracking_number'],
          },
        }),
        shipment,
      );
    expect(withRelationship('work')).toEqual([]);
    expect(withRelationship('colleague').join()).toMatch(/relationship is one of family, work, social, other/);
  });
});

describe('text read one way (§9)', () => {
  it('reads text canonical: compatibility form, nothing that shows nothing, any space a space, a hyphen a hyphen', () => {
    expect(canonicalMailFactText('\uFF21\uFF0D\uFF11\uFF12\uFF13')).toBe('A-123');
    expect(canonicalMailFactText('\u{1D7D2}\u{1D7CF}')).toBe('41');
    expect(canonicalMailFactText('sign\u2011in\u200B now\u00A0\u2028next')).toBe('sign-in now \nnext');
    // The spaces compatibility form leaves as they are: a tab, a form feed, an ogham space.
    expect(canonicalMailFactText('a\tb\u000Bc\u000Cd\u1680e')).toBe('a b c d e');
    // A dash that is no hyphen is left for the reader that tells them apart.
    expect(canonicalMailFactText('9:00\u201310:00 \u221207:00')).toBe('9:00\u201310:00 \u221207:00');
    expect(mailFactStoredText('  \uFF33hop\u3000\u3000A \u200B')).toBe('Shop A');
    expect(mailFactStoredId('\uFF03\uFF11\uFF12 \u200B34')).toBe('1234');
    expect(canonicalMailFactCarrier('\uFF35\uFF30\uFF33 Ground')).toBe('UPS');
    expect(canonicalMailFactCarrier('Royal\u00A0 Mail')).toBe('Royal Mail');
  });

  it('reads a pattern’s characters as the text is, and changes nothing else about it', () => {
    const exec = (pattern: string, text: string, flags = '') => new RegExp(canonicalMailFactPattern(pattern), flags).exec(text);
    // ASCII is left as written.
    expect(canonicalMailFactPattern('Order #(\\d+)\\s*[a-z]{2,3}')).toBe('Order #(\\d+)\\s*[a-z]{2,3}');
    // A fullwidth colon is the colon the text now holds.
    expect(exec('注文番号：(\\S+)', '注文番号:A-1')?.[1]).toBe('A-1');
    // A fullwidth bracket is a bracket to match, never a group; a fullwidth dot a dot, never any character.
    expect(exec('（(\\d+)）', 'x (123) y')?.slice(1)).toEqual(['123']);
    expect(exec('a．b', 'axb')).toBeNull();
    expect(exec('a．b', 'a.b')?.[0]).toBe('a.b');
    // In a class, a fullwidth range is the plain range.
    expect(exec('^[Ａ-Ｚ０-９]+$', 'AB12')?.[0]).toBe('AB12');
    // What shows nothing is nothing: a quantifier after it does not move onto the character before.
    expect(exec('ab\u200B+', 'abbb')?.[0]).toBe('ab');
    expect(exec('^[\u200Bx]$', 'x')?.[0]).toBe('x');
    expect(exec('^[\u200Bx]$', '(')).toBeNull();
    // A class ends where it ends: after it, what shows nothing is an empty group again.
    expect(exec('[a]b\u200B+', 'abbb')?.[0]).toBe('ab');
    // An escaped character past ASCII stands for itself.
    expect(exec('\\：(\\d)', ':7')?.[1]).toBe('7');
  });

  it('checks a pattern as it runs: what compiles here compiles there', () => {
    const pattern = (value: string) => validateMailTemplateDefinition(shipmentTemplate({
      rules: [...shipmentTemplate().rules, { target: { data: 'code' }, source: 'body', find: { kind: 'pattern', pattern: value } }],
    }), shipment).join();
    // A zero-width joiner may sit in a group's name as written; read as it runs, the name breaks.
    expect(() => new RegExp('(?<a\u200Db>x)')).not.toThrow();
    expect(pattern('(?<a\u200Db>x)')).toMatch(/pattern does not compile/);
    // Its fullwidth brackets are no group: one capture group, as written.
    expect(pattern('（(\\d+)）')).toBe('');
  });

  it('refuses a value that reads as nothing, which every email contains', () => {
    const nothing = '\u200B\u2060';
    const problems = (over: Partial<MailTemplateDefinition>) => validateMailTemplateDefinition(shipmentTemplate(over), shipment).join();
    expect(problems({
      entrance: { conditions: [{ field: 'subject', op: 'contains', value: nothing }], variables: ['carrier', 'tracking_number'] },
    })).toMatch(/value is required — it holds only spaces or characters that show nothing/);
    expect(problems({
      entrance: { conditions: [{ field: 'subject', op: 'contains', value: '   ' }], variables: ['carrier', 'tracking_number'] },
    })).toMatch(/value is required — it holds only spaces/);
    expect(problems({
      rules: shipmentTemplate().rules.map((rule) => (rule.find.kind === 'after_label' ? { ...rule, find: { kind: 'after_label' as const, label: nothing } } : rule)),
    })).toMatch(/after_label needs a label/);
    expect(problems({
      rules: shipmentTemplate().rules.map((rule) => (rule.find.kind === 'keyword_map'
        ? { ...rule, find: { kind: 'keyword_map' as const, cases: [{ contains: 'Delivered', value: 'delivered' }, { contains: nothing, value: 'in_transit' }] } }
        : rule)),
    })).toMatch(/keyword_map case 2 needs text to look for/);
    // A pattern of spaces is a pattern: it matches spaces.
    expect(problems({
      entrance: { conditions: [{ field: 'subject', op: 'matches', value: '  ' }], variables: ['carrier', 'tracking_number'] },
    })).not.toMatch(/value is required/);
    // A split of nothing splits everywhere, as it runs.
    expect(problems({ repeat: { source: 'body', split: nothing } })).toMatch(/repeat.split matches an empty text/);
    expect(problems({})).toBe('');
  });

  it('never counts as narrowing past the domain what reads as nothing (§4.1)', () => {
    const nothing = '\u200B\u2060';
    const domain = { field: 'from' as const, op: 'domain_is' as const, value: 'amazon.com' };
    const narrows = (conditions: MailTemplateDefinition['entrance']['conditions'], rules: MailTemplateDefinition['rules'] = [], variables: string[] = []) =>
      mailTemplateNarrowsPastDomain({ entrance: { conditions, variables }, rules });
    expect(narrows([domain, { field: 'subject', op: 'contains', value: nothing }])).toBe(false);
    expect(narrows([domain, { field: 'subject', op: 'contains', value: 'shipped' }])).toBe(true);
    // A pattern of nothing matches an empty text as it runs.
    expect(narrows([domain, { field: 'subject', op: 'matches', value: nothing }])).toBe(false);
    const read = (find: MailTemplateDefinition['rules'][number]['find']) =>
      narrows([domain], [{ target: { variable: 'tracking_number' }, source: 'body', find }], ['tracking_number']);
    expect(read({ kind: 'after_label', label: nothing })).toBe(false);
    expect(read({ kind: 'after_label', label: 'Tracking:' })).toBe(true);
    expect(read({ kind: 'keyword_map', cases: [{ contains: 'Delivered', value: 'x' }, { contains: nothing, value: 'y' }] })).toBe(false);
    expect(read({ kind: 'keyword_map', cases: [{ contains: 'Delivered', value: 'x' }] })).toBe(true);
    expect(read({ kind: 'pattern', pattern: `(${nothing})` })).toBe(false);
  });
});

describe('a recipe’s starter template (§5.2)', () => {
  it('takes a built-in kind’s template that holds nothing of its author’s mail', () => {
    expect(mailTemplateStarterProblems(shipmentTemplate())).toEqual([]);
    // A number's shape is a pattern, not a number: quantifiers are no digits.
    expect(mailTemplateStarterProblems(shipmentTemplate({
      rules: [...shipmentTemplate().rules, { target: { data: 'order' }, source: 'body', find: { kind: 'pattern', pattern: 'Order #(\\d{3}-\\d{7}-\\d{7})' } }],
    }))).toEqual([]);
  });

  it('refuses a kind an owner made: it exists only on that server', () => {
    expect(mailTemplateStarterProblems({ ...shipmentTemplate(), type: 'custom_ticket' })).toEqual([
      "type 'custom_ticket' is a kind of email made on one server: a starter's kind must be built in",
    ]);
  });

  it('refuses what the template check refuses', () => {
    expect(mailTemplateStarterProblems(shipmentTemplate({ name: ' ' })).join()).toMatch(/name is required/);
    expect(mailTemplateStarterProblems({ name: 'x' })[0]).toMatch(/must/);
  });

  it('refuses, where it is, an address, a phone number or a number baked into a rule, the prompt or a condition', () => {
    const rules = shipmentTemplate().rules;
    const problems = mailTemplateStarterProblems(shipmentTemplate({
      entrance: {
        conditions: [
          { field: 'from', op: 'is', value: 'pkginfo@ups.com' },
          { field: 'subject', op: 'contains', value: 'Order 112-3345678' },
        ],
        variables: ['carrier', 'tracking_number'],
      },
      rules: [
        rules[0]!,
        { target: { variable: 'tracking_number' }, source: 'body', find: { kind: 'after_label', label: 'Sent to alex@example.com:' } },
        { target: { data: 'phone' }, source: 'body', find: { kind: 'constant', value: 'call +1 (555) 123-4567' } },
        { target: { data: 'order' }, source: 'body', find: { kind: 'pattern', pattern: 'Parcel 1Z999AA10123456784 for (\\w+)' } },
        { target: { variable: 'state' }, source: 'subject', find: { kind: 'keyword_map', cases: [{ contains: 'Delivered', value: 'delivered' }] } },
      ],
      ai: { enabled: true, prompt: 'Mail from bob@example.org about his orders.', slots: ['data.note'], pool: 'free_only' },
    }));
    expect(problems).toEqual([
      'entrance.conditions[1].value: holds a long run of digits (10) — an order or a tracking number baked in',
      'rules[1].find.label: holds an email address',
      'rules[2].find.value: holds a phone number',
      'rules[3].find.pattern: holds a long run of digits (11) — an order or a tracking number baked in',
      'ai.prompt: holds an email address',
    ]);
  });

  it('refuses its author’s own addresses and names anywhere, and a sender in its author’s contacts', () => {
    const problems = mailTemplateStarterProblems(shipmentTemplate({
      entrance: {
        conditions: [{ field: 'from', op: 'is', value: 'Friend@Example.com' }, { field: 'subject', op: 'contains', value: 'for Alex Doe' }],
        variables: ['carrier', 'tracking_number'],
      },
    }), { words: ['Alex Doe', 'alex@home.example'], senders: ['friend@example.com'] });
    expect(problems).toEqual([
      'entrance.conditions[0].value: names a sender in its author’s contacts'.replace('’', "'"),
      "entrance.conditions[1].value: holds its author's own address or name",
    ]);
  });
});

describe('an AI that is off keeps what switching it on needs (§5.2)', () => {
  const domainOnly = { conditions: [{ field: 'from' as const, op: 'domain_is' as const, value: 'ups.com' }], variables: [] };

  it('is a template the check takes, and the rebuilt definition keeps it', () => {
    const kept = shipmentTemplate({ ai: { enabled: false, prompt: 'Read the depot.', slots: ['data.depot'], pool: 'free_only' } });
    expect(validateMailTemplateDefinition(kept, getMailFactBuiltinType('shipment'))).toEqual([]);
    expect(mailTemplateDefinitionOf(kept).ai).toEqual({ enabled: false, prompt: 'Read the depot.', slots: ['data.depot'], pool: 'free_only' });
    expect(mailTemplateDefinitionOf(shipmentTemplate({ ai: { enabled: false } })).ai).toEqual({ enabled: false });
    // What an AI that is on must narrow is asked when it is switched on.
    expect(validateMailTemplateDefinition(
      shipmentTemplate({ entrance: domainOnly, ai: { enabled: false, prompt: 'Read the depot.', slots: ['data.depot'] } }),
      getMailFactBuiltinType('shipment'),
    )).toEqual([]);
    expect(validateMailTemplateDefinition(
      shipmentTemplate({ entrance: domainOnly, ai: { enabled: true, prompt: 'Read the depot.', slots: ['data.depot'], pool: 'free_only' } }),
      getMailFactBuiltinType('shipment'),
    ).join()).toMatch(/more than the sender's domain/);
  });

  it('checks what it keeps as it will be checked when on', () => {
    const problems = (ai: object) =>
      validateMailTemplateDefinition(shipmentTemplate({ ai: ai as never }), getMailFactBuiltinType('shipment'));
    expect(problems({ enabled: false, slots: ['data.depot'] })).toEqual(['an AI that is off keeps a prompt with its slots, or keeps neither']);
    expect(problems({ enabled: false, prompt: 'Read it.', pool: 'everything' })[0]).toMatch(/ai.pool must be one of/);
    expect(problems({ enabled: false, prompt: 'Read it.', slots: ['carrier'] })[0]).toMatch(/entrance variable/);
    expect(problems({ enabled: false, prompt: 'x'.repeat(MAIL_TEMPLATE_LIMITS.maxPromptLength + 1) })[0]).toMatch(/longer than/);
  });

  it('a starter’s kept prompt travels, so it is checked for its author’s mail', () => {
    expect(mailTemplateStarterProblems(shipmentTemplate({
      ai: { enabled: false, prompt: 'Mail from bob@example.org.', slots: [] },
    }))).toEqual(['ai.prompt: holds an email address']);
  });
});

describe('a recipe’s starters, as install reads them (§5.2)', () => {
  it('finds each mail_template variable that brings one, in the recipe’s order', () => {
    const starter = shipmentTemplate();
    expect(mailTemplateStarters({
      note: { label: 'Note', type: 'text' },
      ups: { label: 'UPS', type: 'mail_template', starter },
      pick: { label: 'Pick one', type: 'mail_template' },
      odd: { label: 'Odd', type: 'text', starter },
    })).toEqual([{ variable: 'ups', starter }]);
    expect(mailTemplateStarters(undefined)).toEqual([]);
    expect(mailTemplateStarters([])).toEqual([]);
  });

  it('says what a template reads: its variables and data, each once', () => {
    expect(mailTemplateReads(shipmentTemplate({
      rules: [
        ...shipmentTemplate().rules,
        { target: { data: 'depot' }, source: 'body', find: { kind: 'after_label', label: 'Depot:' } },
        { target: { variable: 'state' }, source: 'body', find: { kind: 'constant', value: 'in_transit' } },
      ],
    }))).toEqual(['carrier', 'tracking_number', 'state', 'data.depot']);
  });
});

describe('validateMailFactCustomType (§4.5)', () => {
  const custom = (over: Partial<MailFactTypeSpec> = {}): MailFactTypeSpec => ({
    id: 'custom_wine_club',
    name: 'Wine club',
    description: 'A wine club shipment.',
    variables: [
      { name: 'club', kind: 'text', required: true },
      { name: 'box_id', kind: 'id', required: true },
    ],
    states: ['shipped'],
    notices: [],
    identity: [['club', 'box_id']],
    ...over,
  });

  it('accepts a well-formed owner type', () => {
    expect(validateMailFactCustomType(custom())).toEqual([]);
  });

  it('refuses reserved, repeated or badly named variables, and an undeclared identity', () => {
    const problems = validateMailFactCustomType(
      custom({
        variables: [
          { name: 'state', kind: 'text', required: false },
          { name: 'club', kind: 'text', required: true },
          { name: 'club', kind: 'text', required: true },
          { name: 'Bad Name', kind: 'text', required: false },
        ],
        identity: [['club', 'box_id']],
      }),
    );
    expect(problems.join()).toMatch(/'state' is a reserved name/);
    expect(problems.join()).toMatch(/'club' is declared twice/);
    expect(problems.join()).toMatch(/'Bad Name' must be lower-case/);
    expect(problems.join()).toMatch(/identity names 'box_id'/);
  });

  it('refuses an account reference of any kind but text: it holds an account’s last four characters', () => {
    const declared = (kind: MailFactTypeSpec['variables'][number]['kind']) => validateMailFactCustomType(custom({
      variables: [
        { name: 'club', kind: 'text', required: true },
        { name: 'box_id', kind: 'id', required: true },
        { name: 'account_ref', kind, required: false },
      ],
    }));
    expect(declared('number').join()).toMatch(/'account_ref' holds an account's last four characters: it is text/);
    expect(declared('money').join()).toMatch(/'account_ref' holds an account's last four characters: it is text/);
    expect(declared('text')).toEqual([]);
  });

  it('refuses a slug equal to a built-in type', () => {
    expect(validateMailFactCustomType(custom({ id: 'custom_shipment' })).join()).toMatch(/reads like the built-in/);
  });

  it('refuses what its facts, events and editor could not use', () => {
    const problems = validateMailFactCustomType(custom({
      name: ' ',
      variables: [
        { name: 'colour', kind: 'enum', required: false, values: ['Red', 'white', 'white'] },
        { name: 'label', kind: 'text', required: false, values: ['x'] },
        { name: 'scan', kind: 'file', required: false },
      ],
      states: ['shipped', 'shipped', 'On Hold'],
      identity: [['scan'], []],
      data_fields: [{ path: 'Items', kind: 'list' }, { path: 'notes', kind: 'essay' as never }],
    })).join('\n');
    expect(problems).toMatch(/name is required/);
    expect(problems).toMatch(/value 'Red' must be lower-case/);
    expect(problems).toMatch(/'colour' repeats a value/);
    expect(problems).toMatch(/'label': only an enum declares values/);
    expect(problems).toMatch(/state 'On Hold' must be lower-case/);
    expect(problems).toMatch(/a state is listed twice/);
    expect(problems).toMatch(/an attachment cannot tell one thing from another/);
    expect(problems).toMatch(/an identity names 1 to 4 variables/);
    expect(problems).toMatch(/data field 'Items' must be dot-separated/);
    expect(problems).toMatch(/data field 'notes' has an unknown kind 'essay'/);
    expect(validateMailFactCustomType(custom({ variables: [] })).join()).toMatch(/at least one variable/);
  });
});

describe('an owner type only grows (§4.5, slice 5)', () => {
  const before: MailFactTypeSpec = {
    id: 'custom_wine_club',
    name: 'Wine club',
    description: '',
    variables: [
      { name: 'club', kind: 'text', required: true },
      { name: 'colour', kind: 'enum', required: false, values: ['red', 'white'] },
    ],
    states: ['shipped'],
    notices: ['reminder'],
    identity: [['club']],
  };

  it('may gain variables, values, states and data fields, be renamed, and change what is required', () => {
    expect(validateMailFactTypeChange(before, {
      ...before,
      name: 'Wine club boxes',
      variables: [
        { name: 'club', kind: 'text', required: false, description: 'The club' },
        { name: 'colour', kind: 'enum', required: false, values: ['red', 'white', 'rose'] },
        { name: 'box_id', kind: 'id', required: false },
      ],
      states: ['shipped', 'delivered'],
      data_fields: [{ path: 'bottles', kind: 'list' }],
    })).toEqual([]);
  });

  it('keeps everything its facts, templates and triggers name', () => {
    const problems = validateMailFactTypeChange(before, {
      ...before,
      id: 'custom_wine' as MailFactTypeSpec['id'],
      variables: [{ name: 'colour', kind: 'text', required: false }],
      states: [],
      notices: [],
      identity: [['colour']],
    }).join('\n');
    expect(problems).toMatch(/keeps its id/);
    expect(problems).toMatch(/variable 'club' cannot be removed/);
    expect(problems).toMatch(/variable 'colour' keeps its kind \(enum\)/);
    expect(problems).toMatch(/the state 'shipped' cannot be removed/);
    expect(problems).toMatch(/the notice 'reminder' cannot be removed/);
    expect(problems).toMatch(/how one thing is told from another cannot change/);
    expect(validateMailFactTypeChange(before, {
      ...before,
      variables: [before.variables[0]!, { name: 'colour', kind: 'enum', required: false, values: ['red'] }],
    }).join()).toMatch(/keeps its value 'white'/);
  });
});

describe('the owner’s rpc (§6)', () => {
  const methods = [
    'mail_fact.template.list',
    'mail_fact.template.get',
    'mail_fact.template.create',
    'mail_fact.template.update',
    'mail_fact.template.delete',
    'mail_fact.standards.get',
    'mail_fact.standards.set',
    'mail_fact.facts.list',
    'mail_fact.email.get',
    'mail_fact.email.read',
    'mail_fact.template.preview',
    'mail_fact.template.draft',
    'mail_fact.type.list',
    'mail_fact.type.create',
    'mail_fact.type.update',
    'mail_fact.type.delete',
    'mail_fact.senders.list',
    'mail_fact.senders.dismiss',
    'mail_fact.backfill.start',
    'mail_fact.backfill.get',
    'mail_fact.backfill.cancel',
  ] as const;

  it('registers each method once and reserves the family out of MCP', () => {
    expect(MCP_RESERVED_RPC_PREFIXES).toContain('mail_fact.');
    for (const method of methods) {
      expect(SERVER_RPC_METHODS.filter((candidate) => candidate === method)).toHaveLength(1);
      expect(isReservedLocalRpc(method)).toBe(true);
    }
  });
});
