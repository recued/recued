import { describe, expect, it, vi } from 'vitest';

import {
  CONTACT_ATTRIBUTE_TEMPLATES,
  createContactAttributePresenceProbe,
  createTemplateRenderer,
  matchContactAttributeTemplate,
  type ContactAttributeLookup,
  type ContactAttributeRow,
  type DataSnapshot,
} from '../index';
import type { SlotValue } from '../ner/index';
import { renderRenderTemplate, TemplateRenderError } from '../templates/index';
import type { SlotName, Template } from '../types';

const makeSlot = (
  kind: SlotName,
  value: string,
  position = 0,
): SlotValue => ({
  kind,
  value,
  raw: value,
  position,
});

const nameSlot = (value = 'Alice Bond', position = 8): SlotValue =>
  makeSlot('entity.name', value, position);

const snapshot = (data: Readonly<Record<string, unknown>>): DataSnapshot => ({
  data,
});

const runProbe = async (
  lookup: ContactAttributeLookup,
  slots: ReadonlyArray<SlotValue> = [nameSlot()],
): Promise<DataSnapshot | null> => {
  const probe = createContactAttributePresenceProbe(lookup);
  return await probe({
    template: CONTACT_ATTRIBUTE_TEMPLATES.email,
    slots,
  });
};

const match = (
  text: string,
  slots: ReadonlyArray<SlotValue> = [nameSlot()],
): Template | null =>
  // `matchContactAttributeTemplate` is declared as a `TemplateMatcher` (which
  // permits an async result); this implementation is synchronous, so narrow
  // the union for the synchronous assertions below.
  matchContactAttributeTemplate({
    text,
    slots,
    locale: 'en',
  }) as Template | null;

const expectRenderTemplate = (template: Template | null): Exclude<Template, { kind: 'structural_plan' }> => {
  if (template === null || template.kind !== 'render_template') {
    throw new Error('expected render_template');
  }
  return template;
};

describe('D-164 P5 contact-attribute data presence probe', () => {
  it('fires on a unique exact-name match and snapshots the present contact fields', async () => {
    const lookup = vi.fn<ContactAttributeLookup>(() => [{
      name: 'alice  bond',
      email: 'alice@x.com',
      phone: '+14155550199',
      company: 'MI6',
    }]);

    const out = await runProbe(lookup, [nameSlot('Alice Bond')]);

    expect(lookup).toHaveBeenCalledWith('Alice Bond');
    expect(out).not.toBeNull();
    expect(out?.data).toEqual({
      name: 'alice  bond',
      email: 'alice@x.com',
      phone: '+14155550199',
      company: 'MI6',
    });
  });

  it.each([
    ['zero exact matches', [{ name: 'Bob Stone', email: 'bob@x.com' }]],
    ['two exact matches', [
      { name: 'Alice Bond', email: 'alice-1@x.com' },
      { name: 'alice  bond', email: 'alice-2@x.com' },
    ]],
  ] satisfies ReadonlyArray<readonly [string, readonly ContactAttributeRow[]]>)(
    'returns null for %s',
    async (_label, rows) => {
      await expect(runProbe(() => rows)).resolves.toBeNull();
    },
  );

  it('filters substring near-misses returned by the substring lookup', async () => {
    await expect(runProbe(() => [
      { name: 'Alice Bondsmith', email: 'bondsmith@x.com' },
    ])).resolves.toBeNull();
  });

  it.each([
    ['zero names', []],
    ['two names', [nameSlot('Alice Bond'), nameSlot('Alice Carter', 21)]],
  ] satisfies ReadonlyArray<readonly [string, readonly SlotValue[]]>)(
    'returns null when slots contain %s',
    async (_label, slots) => {
      const lookup = vi.fn<ContactAttributeLookup>(() => [{
        name: 'Alice Bond',
        email: 'alice@x.com',
      }]);

      await expect(runProbe(lookup, slots)).resolves.toBeNull();
      expect(lookup).not.toHaveBeenCalled();
    },
  );

  it('returns null when the unique lookup row has no usable display name', async () => {
    await expect(runProbe(() => [
      { email: 'alice@x.com', phone: '+14155550199' },
    ])).resolves.toBeNull();
  });

  it.each([
    [
      'whitespace phone and empty company',
      { name: 'Alice Bond', email: 'alice@x.com', phone: '   ', company: '' },
      { name: 'Alice Bond', email: 'alice@x.com' },
    ],
    [
      'missing phone',
      { name: 'Alice Bond', email: 'alice@x.com', company: 'ACME' },
      { name: 'Alice Bond', email: 'alice@x.com', company: 'ACME' },
    ],
  ] satisfies ReadonlyArray<readonly [
    string,
    ContactAttributeRow,
    Readonly<Record<string, string>>,
  ]>)('omits non-present fields for %s', async (_label, row, expected) => {
    const out = await runProbe(() => [row]);

    expect(out?.data).toEqual(expected);
    expect(Object.prototype.hasOwnProperty.call(out?.data ?? {}, 'phone')).toBe(false);
  });

  it('returns frozen by-value snapshot data', async () => {
    const row: { name?: string; email?: string; phone?: string; company?: string } = {
      name: 'Alice Bond',
      email: 'alice@x.com',
      phone: '+14155550199',
      company: 'ACME',
    };

    const out = await runProbe(() => [row]);
    if (out === null) throw new Error('expected snapshot');

    expect(Object.isFrozen(out.data)).toBe(true);
    row.email = 'changed@x.com';
    row.phone = '+14155550000';
    row.company = 'Changed Co';
    expect(out.data).toEqual({
      name: 'Alice Bond',
      email: 'alice@x.com',
      phone: '+14155550199',
      company: 'ACME',
    });
  });

  it.each(['sync', 'async'] as const)('awaits %s lookup results', async (mode) => {
    const lookup = mode === 'sync'
      ? vi.fn<ContactAttributeLookup>(() => [{ name: 'Alice Bond', email: 'sync@x.com' }])
      : vi.fn<ContactAttributeLookup>(async () => [{ name: 'Alice Bond', email: 'async@x.com' }]);

    const out = await runProbe(lookup);

    expect(out?.data.email).toBe(`${mode}@x.com`);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('turns a throwing lookup into null instead of throwing', async () => {
    const lookup = vi.fn<ContactAttributeLookup>(() => {
      throw new Error('warehouse unavailable');
    });

    await expect(runProbe(lookup)).resolves.toBeNull();
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('renders company from the probe snapshot when the company field is present', async () => {
    const out = await runProbe(() => [{
      name: 'Alice Bond',
      company: 'ACME',
    }]);
    if (out === null) throw new Error('expected snapshot');

    expect(out.data).toEqual({
      name: 'Alice Bond',
      company: 'ACME',
    });
    expect(renderRenderTemplate(CONTACT_ATTRIBUTE_TEMPLATES.company, out))
      .toBe('Alice Bond works at ACME.');
  });

  it.each([
    ['missing company', { name: 'Alice Bond', email: 'alice@x.com' }],
    ['whitespace-only company', { name: 'Alice Bond', company: '   ' }],
  ] satisfies ReadonlyArray<readonly [string, ContactAttributeRow]>)(
    'omits %s and lets render throw for empty-render defer',
    async (_label, row) => {
      const out = await runProbe(() => [row]);
      if (out === null) throw new Error('expected snapshot');

      expect(Object.prototype.hasOwnProperty.call(out.data, 'company')).toBe(false);
      expect(() => renderRenderTemplate(CONTACT_ATTRIBUTE_TEMPLATES.company, out))
        .toThrow(TemplateRenderError);
      expect(createTemplateRenderer()(CONTACT_ATTRIBUTE_TEMPLATES.company, out)).toBe('');
    },
  );
});

describe('D-164 P5 contact-attribute template matcher', () => {
  it('matches possessive email and phone attribute requests', () => {
    expect(match("what is Alice Bond's email address?"))
      .toBe(CONTACT_ATTRIBUTE_TEMPLATES.email);

    for (const attr of ['phone number', 'cell', 'mobile']) {
      expect(match(`what is Alice Bond's ${attr}?`), attr)
        .toBe(CONTACT_ATTRIBUTE_TEMPLATES.phone);
    }
  });

  it.each([
    ["What is Alice Bond's company?"],
    ["what's alice bond's employer?"],
    ['what’s alice bond’s employer?'],
    ['Where does Alice Bond work?'],
    ['Which company does Alice Bond work for?'],
    ['What company does Alice Bond work at?'],
    ["whats Alice Bond's company"],
    ["What  is  Alice  Bond's  company?"],
  ])('matches anchored company employer request: %s', (text) => {
    const template = match(text);

    expect(template).toBe(CONTACT_ATTRIBUTE_TEMPLATES.company);
    expect(template?.template_hash).toBe('recued/contact-company-by-name@v1');
  });

  it.each([
    ['tell me about Alice Bond'],
    ['what do you know about Alice Bond'],
    ['find Alice Bond and tell me their email'],
    ["what are Alice Bond's email and phone?"],
    ["Alice Bond's?"],
  ])('returns null for non-renderable read shape: %s', (text) => {
    expect(match(text)).toBeNull();
  });

  it.each([
    ["Do you enjoy Alice Bond's company?"],
    ["I was in Alice Bond's company yesterday"],
    ["What is Alice Bond's company policy on returns?"],
    ['Where does Alice Bond work out?'],
    ['Who does Alice Bond work for?'],
    ['Where did Alice Bond work?'],
    ["What was Alice Bond's company?"],
    ['Where does Alice Bond work now?'],
    ["Change Alice Bond's company to Acme"],
  ])('returns null for ambiguous or unanchored company shape: %s', (text) => {
    expect(match(text)).toBeNull();
  });

  it('returns null for a company request with a second slot', () => {
    expect(match(
      "What is Alice Bond's company?",
      [nameSlot('Alice Bond'), nameSlot('Bob Stone', 32)],
    )).toBeNull();
  });

  it.each([
    // D-164 P8 / R3 — a yes/no PREDICATE about the attribute is NOT an
    // attribute lookup: the attribute is no longer terminal (a trailing word
    // follows), so it must pass through rather than wrongly answer "Alice
    // Bond's email address is …". (The has-email family handles genuine
    // presence questions like "do I have Alice Bond's email?".)
    ["is Alice Bond's email valid?"],
    ["is Alice Bond's email private?"],
    ["does Alice Bond's email bounce?"],
    ["is Alice Bond's email still active?"],
    ["does Alice Bond's phone number still work?"],
  ])('returns null for a yes/no predicate about the attribute (not a lookup): %s', (text) => {
    expect(match(text)).toBeNull();
  });

  it.each([
    ['zero names', []],
    ['two names', [nameSlot('Alice Bond'), nameSlot('Bob Stone', 18)]],
    [
      'one name plus entity.email',
      [nameSlot('Alice Bond'), makeSlot('entity.email', 'new@x.com', 35)],
    ],
    [
      'one name plus date',
      [nameSlot('Alice Bond'), makeSlot('date', '2026-06-08', 35)],
    ],
    [
      'one name plus time',
      [nameSlot('Alice Bond'), makeSlot('time', '13:00', 35)],
    ],
  ] satisfies ReadonlyArray<readonly [string, readonly SlotValue[]]>)(
    'returns null when slots are not exactly one entity.name: %s',
    (_label, slots) => {
      expect(match("what is Alice Bond's email address?", slots)).toBeNull();
    },
  );

  it.each([
    'change',
    'set',
    'update',
    'delete',
    'remove',
    'replace',
    'rename',
    'edit',
    'modify',
    'clear',
    'reset',
    'correct',
    'assign',
    'changing',
    'sets',
    'updating',
  ])('returns null for mutation prompt verb: %s', (verb) => {
    expect(match(`${verb} Alice Bond's email to new@x.com`)).toBeNull();
  });

  it('matches possessive attribute requests across case and collapsed whitespace', () => {
    expect(match(
      "WHAT  IS  ALICE  BOND'S  E-MAIL  ADDRESS?",
      [nameSlot('aLiCe  BoNd')],
    )).toBe(CONTACT_ATTRIBUTE_TEMPLATES.email);
  });

  it.each([
    'Captain Alice Bond',
    'General Alice Bond',
    'Lieutenant Alice Bond',
  ])('rank-guards the possessive company form for leading rank: %s', (rankedName) => {
    expect(match(
      `What is ${rankedName}'s company?`,
      [nameSlot(rankedName)],
    )).toBeNull();
  });

  it('keeps the leading-rank guard scoped to possessive company lookups', () => {
    expect(match(
      'Where does Captain Alice Bond work?',
      [nameSlot('Captain Alice Bond')],
    )).toBe(CONTACT_ATTRIBUTE_TEMPLATES.company);
    expect(match(
      "What is Alice Captain's company?",
      [nameSlot('Alice Captain')],
    )).toBe(CONTACT_ATTRIBUTE_TEMPLATES.company);
    expect(match(
      "What is Captain Alice Bond's email?",
      [nameSlot('Captain Alice Bond')],
    )).toBe(CONTACT_ATTRIBUTE_TEMPLATES.email);
  });

  it.each([
    ["What is Alice Bond's work email?"],
    ["Alice Bond's company email?"],
    ["Alice Bond's company phone?"],
    ["Alice Bond's email and phone?"],
  ])('defers multi-attribute or qualified attribute lookup: %s', (text) => {
    expect(match(text)).toBeNull();
  });

  it('still matches plain single email and phone lookups', () => {
    expect(match("What is Alice Bond's email?")).toBe(CONTACT_ATTRIBUTE_TEMPLATES.email);
    expect(match("What is Alice Bond's phone?")).toBe(CONTACT_ATTRIBUTE_TEMPLATES.phone);
  });

  it('returns render templates with the expected metadata and render bodies', () => {
    const renderer = createTemplateRenderer();
    const email = expectRenderTemplate(match("what is Alice Bond's email address?"));
    const phone = expectRenderTemplate(match("what is Alice Bond's phone number?"));
    const company = expectRenderTemplate(match("what is Alice Bond's company?"));

    expect(email).toBe(CONTACT_ATTRIBUTE_TEMPLATES.email);
    expect(email.kind).toBe('render_template');
    expect(email.short_circuit_eligible).toBe(true);
    expect(email.slot_grammar).toEqual(['entity.name']);
    expect(email.body).toBe("{{name}}'s email address is {{email}}.");
    expect(renderer(email, snapshot({
      name: 'Alice Bond',
      email: 'alice@x.com',
    }))).toBe("Alice Bond's email address is alice@x.com.");
    expect(renderer(email, snapshot({ name: 'Alice Bond' }))).toBe('');

    expect(phone).toBe(CONTACT_ATTRIBUTE_TEMPLATES.phone);
    expect(phone.kind).toBe('render_template');
    expect(phone.short_circuit_eligible).toBe(true);
    expect(phone.slot_grammar).toEqual(['entity.name']);
    expect(phone.body).toBe("{{name}}'s phone number is {{phone}}.");
    expect(renderer(phone, snapshot({
      name: 'Alice Bond',
      phone: '+14155550199',
    }))).toBe("Alice Bond's phone number is +14155550199.");
    expect(renderer(phone, snapshot({ name: 'Alice Bond' }))).toBe('');

    expect(company).toBe(CONTACT_ATTRIBUTE_TEMPLATES.company);
    expect(company.kind).toBe('render_template');
    expect(company.short_circuit_eligible).toBe(true);
    expect(company.slot_grammar).toEqual(['entity.name']);
    expect(company.body).toBe('{{name}} works at {{company}}.');
    expect(renderer(company, snapshot({
      name: 'Alice Bond',
      company: 'ACME',
    }))).toBe('Alice Bond works at ACME.');
    expect(renderer(company, snapshot({ name: 'Alice Bond' }))).toBe('');
  });
});
