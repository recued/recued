import { describe, expect, it, vi } from 'vitest';

import {
  CONTACT_ATTRIBUTE_LIST_TEMPLATE_DESCRIPTORS,
  CONTACT_ATTRIBUTE_LIST_TEMPLATES_BY_LOCALE,
  createContactAttributeListPresenceProbe,
  createContactAttributePresenceProbe,
  createTemplateRenderer,
  matchContactAttributeListTemplate,
  matchContactAttributeTemplate,
  type ContactAttributeLookup,
} from '../index.js';
import {
  extract,
  type KnownEntityNameCandidate,
  type SlotValue,
  type SupportedLocale,
} from '../ner/index.js';
import type { RenderTemplate } from '../types.js';

const exactCandidate = (
  surface: string,
  canonicalValue = 'Alice Bond',
  referenceKey = 'contact_alice',
  evidence: KnownEntityNameCandidate['evidence'] = 'email',
): KnownEntityNameCandidate => ({ surface, canonicalValue, referenceKey, evidence });

const renderMatched = async (
  text: string,
  lookup: ContactAttributeLookup,
  knownNames?: readonly (string | KnownEntityNameCandidate)[],
): Promise<string> => {
  const extraction = extract(text, { knownNames });
  if (extraction === null) throw new Error(`expected extraction: ${text}`);
  const template = await matchContactAttributeTemplate({
    text,
    slots: extraction.slots,
    locale: extraction.locale,
    localeCandidates: extraction.localeCandidates,
  });
  if (template === null || template.kind !== 'render_template') {
    throw new Error(`expected template: ${text}`);
  }
  const snapshot = await createContactAttributePresenceProbe(lookup)({
    template,
    slots: extraction.slots,
    locale: extraction.locale,
  });
  if (snapshot === null) throw new Error(`expected snapshot: ${text}`);
  return await createTemplateRenderer()(template, snapshot);
};

describe('typed exact contact references', () => {
  it('replaces the overlapping universal email slot with one identity-bound contact slot', () => {
    const text = "what is alice@example.com's phone number?";
    const result = extract(text, { knownNames: [exactCandidate('alice@example.com')] });

    expect(result?.slots).toEqual([{
      kind: 'entity.name',
      value: 'Alice Bond',
      raw: 'alice@example.com',
      position: text.indexOf('alice@example.com'),
      referenceKey: 'contact_alice',
      referenceEvidence: 'email',
    }]);
  });

  it('matches grammar against the user alias while the keyed probe resolves the canonical contact', async () => {
    const text = "what is mom's email address?";
    const lookup = vi.fn<ContactAttributeLookup>((name, reference) => [{
      identityKey: reference?.key,
      name,
      email: 'alice@example.com',
    }]);

    await expect(renderMatched(
      text,
      lookup,
      [exactCandidate('mom', 'Alice Bond', 'contact_alice', 'chat-alias')],
    )).resolves.toBe("Alice Bond's email address is alice@example.com.");
    expect(lookup).toHaveBeenCalledWith('Alice Bond', {
      key: 'contact_alice',
      surface: 'mom',
      evidence: 'chat-alias',
    });
  });

  it('defers when the keyed lookup cannot re-attest the same identity', async () => {
    const text = "what is mom's email address?";
    const extraction = extract(text, {
      knownNames: [exactCandidate('mom', 'Alice Bond', 'contact_alice', 'chat-alias')],
    })!;
    const template = await matchContactAttributeTemplate({
      text,
      slots: extraction.slots,
      locale: extraction.locale,
    }) as RenderTemplate;

    await expect(createContactAttributePresenceProbe(() => [{
      identityKey: 'contact_other',
      name: 'Alice Bond',
      email: 'wrong@example.com',
    }])({ template, slots: extraction.slots })).resolves.toBeNull();
  });

  it.each([
    [[exactCandidate('Alice Bond'), 'Alice Bond']],
    [['Alice Bond', exactCandidate('Alice Bond')]],
  ])('prefers an exact identity key when an alias equals the display name', (knownNames) => {
    const result = extract("what is Alice Bond's email address?", { knownNames });
    expect(result?.slots).toEqual([expect.objectContaining({
      kind: 'entity.name',
      value: 'Alice Bond',
      raw: 'Alice Bond',
      referenceKey: 'contact_alice',
    })]);
  });

  it('rejects a phone candidate embedded in a malformed doubled-plus run', () => {
    const result = extract("what is ++14155552101's email address?", {
      knownNames: [exactCandidate(
        '+14155552101',
        'Alice Bond',
        'contact_alice',
        'e164-phone',
      )],
    });
    expect(result?.slots.some((slot) => slot.kind === 'entity.name')).not.toBe(true);
  });
});

describe('strict title and birthday reads', () => {
  const cases: ReadonlyArray<readonly [SupportedLocale, string, string, string]> = [
    ['en', "What is Alice Bond's job title?", 'title', "Alice Bond's job title is Director."],
    ['en', "When is Alice Bond's birthday?", 'birthday', "Alice Bond's birthday is --03-04."],
    ['de', 'Was ist die Berufsbezeichnung von Alice Bond?', 'title', 'Die Berufsbezeichnung von Alice Bond ist Director.'],
    ['de', 'Wann hat Alice Bond Geburtstag?', 'birthday', 'Der Geburtstag von Alice Bond ist --03-04.'],
    ['es', '¿Cuál es el cargo de Alice Bond?', 'title', 'El cargo de Alice Bond es Director.'],
    ['es', '¿Cuándo es el cumpleaños de Alice Bond?', 'birthday', 'El cumpleaños de Alice Bond es --03-04.'],
    ['fr', 'Quel est le poste de Alice Bond ?', 'title', 'Le poste de Alice Bond est Director.'],
    ['fr', 'Quand est l’anniversaire de Alice Bond ?', 'birthday', 'La date d’anniversaire de Alice Bond est --03-04.'],
    ['ja', 'Alice Bondの役職は何ですか？', 'title', 'Alice Bondの役職はDirectorです。'],
    ['ja', 'Alice Bondの誕生日はいつですか？', 'birthday', 'Alice Bondの誕生日は--03-04です。'],
    ['pt', 'Qual é o cargo de Alice Bond?', 'title', 'O cargo de Alice Bond é Director.'],
    ['pt', 'Quando é o aniversário de Alice Bond?', 'birthday', 'O aniversário de Alice Bond é --03-04.'],
    ['zh', '请问Alice Bond的职位是什么？', 'title', 'Alice Bond的职位是Director。'],
    ['zh', '请问Alice Bond的生日是什么时候？', 'birthday', 'Alice Bond的生日是--03-04。'],
  ];

  it.each(cases)('%s matches and renders a %s request', async (_locale, text, _field, answer) => {
    await expect(renderMatched(
      text,
      () => [{ name: 'Alice Bond', title: 'Director', birthday: '--03-04' }],
      ['Alice Bond'],
    )).resolves.toBe(answer);
  });

  it.each([
    "tell me Alice Bond's title",
    "remind me about Alice Bond's birthday",
    "change Alice Bond's job title",
    "what is Alice Bond's birthday party address?",
  ])('rejects an unmodeled or write-shaped sensitive-field request: %s', (text) => {
    const extraction = extract(text, { knownNames: ['Alice Bond'] });
    if (extraction === null) return;
    expect(matchContactAttributeTemplate({
      text,
      slots: extraction.slots,
      locale: extraction.locale,
    })).toBeNull();
  });
});

describe('bounded multi-contact attribute reads', () => {
  const cases: ReadonlyArray<readonly [SupportedLocale, string, string]> = [
    ['en', 'What are the email addresses for Alice Bond and Bob Stone?', 'Email addresses:'],
    ['de', 'Wie lauten die E-Mail-Adressen von Alice Bond und Bob Stone?', 'E-Mail-Adressen:'],
    ['es', '¿Cuáles son los correos electrónicos de Alice Bond y Bob Stone?', 'Correos electrónicos:'],
    ['fr', 'Quelles sont les adresses e-mail de Alice Bond et Bob Stone ?', 'Adresses e-mail :'],
    ['ja', 'Alice BondとBob Stoneのメールアドレスを教えて', 'メールアドレス：'],
    ['pt', 'Quais são os e-mails de Alice Bond e Bob Stone?', 'E-mails:'],
    ['zh', '请告诉我Alice Bond和Bob Stone的邮箱', '电子邮件地址：'],
  ];

  it.each(cases)('%s matches, resolves every row, and renders one complete list', async (
    locale,
    text,
    heading,
  ) => {
    const extraction = extract(text, { knownNames: ['Alice Bond', 'Bob Stone'] });
    expect(extraction?.locale).toBe(locale);
    if (extraction === null) throw new Error('expected extraction');
    const template = await matchContactAttributeListTemplate({
      text,
      slots: extraction.slots,
      locale: extraction.locale,
    });
    if (template === null || template.kind !== 'render_template') {
      throw new Error(`expected list template: ${text}`);
    }
    const probe = createContactAttributeListPresenceProbe(
      (name) => [{
        identityKey: name === 'Alice Bond' ? 'alice' : 'bob',
        name,
        email: name === 'Alice Bond' ? 'alice@example.com' : 'bob@example.com',
      }],
      CONTACT_ATTRIBUTE_LIST_TEMPLATE_DESCRIPTORS,
    );
    const snapshot = await probe({ template, slots: extraction.slots, locale });
    if (snapshot === null) throw new Error('expected list snapshot');

    expect(await createTemplateRenderer()(template, snapshot)).toBe(
      `${heading}\n- Alice Bond: alice@example.com\n- Bob Stone: bob@example.com`,
    );
  });

  it('mints a truthful five-name slot grammar at the upper bound', async () => {
    const names = ['Alice Bond', 'Bob Stone', 'Carol Jones', 'David Young', 'Erin West'];
    const text = `What are the job titles for ${names.slice(0, -1).join(', ')}, and ${names.at(-1)}?`;
    const extraction = extract(text, { knownNames: names });
    if (extraction === null) throw new Error('expected extraction');
    const template = await matchContactAttributeListTemplate({
      text,
      slots: extraction.slots,
      locale: extraction.locale,
    }) as RenderTemplate;

    expect(template.slot_grammar).toEqual(Array.from({ length: 5 }, () => 'entity.name'));
  });

  it.each([
    ['en', 'phone', 'What are the phone numbers for Alice Bond and Bob Stone?'],
    ['en', 'company', 'What are the employers for Alice Bond and Bob Stone?'],
    ['en', 'title', 'What are the job titles for Alice Bond and Bob Stone?'],
    ['en', 'birthday', 'What are the birthdays for Alice Bond and Bob Stone?'],
    ['de', 'phone', 'Wie lauten die Telefonnummern von Alice Bond und Bob Stone?'],
    ['de', 'company', 'Wer sind die Arbeitgeber von Alice Bond und Bob Stone?'],
    ['de', 'title', 'Wie lauten die Berufsbezeichnungen von Alice Bond und Bob Stone?'],
    ['de', 'birthday', 'Wann sind die Geburtstage von Alice Bond und Bob Stone?'],
    ['es', 'phone', '¿Cuáles son los números de teléfono de Alice Bond y Bob Stone?'],
    ['es', 'company', '¿Cuáles son los empleadores de Alice Bond y Bob Stone?'],
    ['es', 'title', '¿Cuáles son los cargos de Alice Bond y Bob Stone?'],
    ['es', 'birthday', '¿Cuándo son los cumpleaños de Alice Bond y Bob Stone?'],
    ['fr', 'phone', 'Quels sont les numéros de téléphone de Alice Bond et Bob Stone ?'],
    ['fr', 'company', 'Quels sont les employeurs de Alice Bond et Bob Stone ?'],
    ['fr', 'title', 'Quels sont les postes de Alice Bond et Bob Stone ?'],
    ['fr', 'birthday', 'Quelles sont les dates d’anniversaire de Alice Bond et Bob Stone ?'],
    ['ja', 'phone', 'Alice BondとBob Stoneの電話番号を教えて'],
    ['ja', 'company', 'Alice BondとBob Stoneの勤務先を教えて'],
    ['ja', 'title', 'Alice BondとBob Stoneの役職を教えて'],
    ['ja', 'birthday', 'Alice BondとBob Stoneの誕生日を教えて'],
    ['pt', 'phone', 'Quais são os números de telefone de Alice Bond e Bob Stone?'],
    ['pt', 'company', 'Quais são os empregadores de Alice Bond e Bob Stone?'],
    ['pt', 'title', 'Quais são os cargos de Alice Bond e Bob Stone?'],
    ['pt', 'birthday', 'Quando são os aniversários de Alice Bond e Bob Stone?'],
    ['zh', 'phone', '请告诉我Alice Bond和Bob Stone的电话号码'],
    ['zh', 'company', '请告诉我Alice Bond和Bob Stone的公司'],
    ['zh', 'title', '请告诉我Alice Bond和Bob Stone的职位'],
    ['zh', 'birthday', '请告诉我Alice Bond和Bob Stone的生日'],
  ] as const)('routes the bounded %s list to its %s descriptor', async (
    locale,
    attribute,
    text,
  ) => {
    const extraction = extract(text, { knownNames: ['Alice Bond', 'Bob Stone'] });
    if (extraction === null) throw new Error('expected extraction');
    expect(await matchContactAttributeListTemplate({
      text,
      slots: extraction.slots,
      locale: extraction.locale,
    })).toBe(CONTACT_ATTRIBUTE_LIST_TEMPLATES_BY_LOCALE[locale][attribute][2]);
  });

  it('defers the whole list on any missing value, duplicate identity, read error, or line injection', async () => {
    const template = CONTACT_ATTRIBUTE_LIST_TEMPLATES_BY_LOCALE.en.email[2];
    const slots: SlotValue[] = [
      { kind: 'entity.name', value: 'Alice Bond', raw: 'Alice Bond', position: 0 },
      { kind: 'entity.name', value: 'Bob Stone', raw: 'Bob Stone', position: 15 },
    ];
    const lookups: ContactAttributeLookup[] = [
      (name) => [{
        identityKey: name === 'Alice Bond' ? 'alice' : 'bob',
        name,
        ...(name === 'Alice Bond' ? { email: 'a@x.com' } : {}),
      }],
      (name) => [{ identityKey: 'same', name, email: `${name}@x.com` }],
      (name) => {
        if (name === 'Bob Stone') throw new Error('warehouse read failed');
        return [{ identityKey: 'alice', name, email: 'a@x.com' }];
      },
      (name) => [{
        identityKey: name === 'Alice Bond' ? 'alice' : 'bob',
        name,
        email: name === 'Alice Bond' ? 'a@x.com' : 'b@x.com\nforged',
      }],
    ];
    for (const lookup of lookups) {
      const probe = createContactAttributeListPresenceProbe(
        lookup,
        CONTACT_ATTRIBUTE_LIST_TEMPLATE_DESCRIPTORS,
      );
      await expect(probe({ template, slots })).resolves.toBeNull();
    }
  });

  it('rejects a sixth contact before matching a list template', async () => {
    const six = Array.from({ length: 6 }, (_, index): SlotValue => ({
      kind: 'entity.name',
      value: `Person ${index}`,
      raw: `Person ${index}`,
      position: index * 10,
    }));
    expect(await matchContactAttributeListTemplate({
      text: 'list',
      slots: six,
      locale: 'en',
    })).toBeNull();
  });
});
