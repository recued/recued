import { describe, expect, it } from 'vitest';

import {
  createCalendarNextMeetingProbe,
  createContactAttributePresenceProbe,
  createContactHasEmailProbe,
  createMailFromCountProbe,
  createTemplateRenderer,
  matchCalendarNextMeetingTemplate,
  matchContactAttributeTemplate,
  matchContactHasEmailTemplate,
  matchMailFromCountTemplate,
  resolveContactHasNoEmailTemplate,
  type DataPresenceProbe,
  type TemplateMatcher,
} from '../index.js';
import { detectLanguages, extract, type SupportedLocale } from '../ner/index.js';
import { hasMutationIntent } from '../templates/locales.js';
import type { RenderTemplate } from '../types.js';

interface LocaleCase {
  readonly locale: Exclude<SupportedLocale, 'en'>;
  readonly name: string;
  readonly attribute: string;
  readonly calendar: string;
  readonly mail: string;
  readonly hasEmail: string;
  readonly mutation: string;
  readonly attributeAnswer: string;
  readonly calendarAnswer: string;
  readonly mailAnswer: string;
  readonly hasEmailAnswer: string;
  readonly noEmailAnswer: string;
}

const CASES: ReadonlyArray<LocaleCase> = [
  {
    locale: 'de',
    name: 'Jörg Müller',
    attribute: 'Wie lautet die E-Mail-Adresse von Jörg Müller?',
    calendar: 'Wann ist meine nächste Besprechung mit Jörg Müller?',
    mail: 'Wie viele E-Mails habe ich von Jörg Müller?',
    hasEmail: 'Habe ich die E-Mail-Adresse von Jörg Müller?',
    mutation: 'Ändere die E-Mail-Adresse von Jörg Müller.',
    attributeAnswer: 'Die E-Mail-Adresse von Jörg Müller ist joerg@example.com.',
    calendarAnswer: 'Ihre nächste Besprechung mit Jörg Müller ist „Planning“ am tomorrow 09:00.',
    mailAnswer: 'Anzahl der E-Mails von Jörg Müller: 3.',
    hasEmailAnswer: 'Ja, die E-Mail-Adresse von Jörg Müller ist joerg@example.com.',
    noEmailAnswer: 'Nein, für Jörg Müller ist keine E-Mail-Adresse gespeichert.',
  },
  {
    locale: 'es',
    name: 'María García',
    attribute: '¿Cuál es el correo electrónico de María García?',
    calendar: '¿Cuándo es mi próxima reunión con María García?',
    mail: '¿Cuántos correos tengo de María García?',
    hasEmail: '¿Tengo el correo electrónico de María García?',
    mutation: 'Cambia el correo electrónico de María García.',
    attributeAnswer: 'El correo electrónico de María García es maria@example.com.',
    calendarAnswer: 'Tu próxima reunión con María García es “Planning” el tomorrow 09:00.',
    mailAnswer: 'Número de correos de María García: 3.',
    hasEmailAnswer: 'Sí, el correo electrónico de María García es maria@example.com.',
    noEmailAnswer: 'No, no hay ningún correo electrónico guardado para María García.',
  },
  {
    locale: 'fr',
    name: 'François Dupont',
    attribute: 'Quelle est l’adresse e-mail de François Dupont ?',
    calendar: 'Quand est ma prochaine réunion avec François Dupont ?',
    mail: 'Combien d’e-mails ai-je de François Dupont ?',
    hasEmail: 'Ai-je l’adresse e-mail de François Dupont ?',
    mutation: 'Modifie l’adresse e-mail de François Dupont.',
    attributeAnswer: 'L’adresse e-mail de François Dupont est francois@example.com.',
    calendarAnswer: 'Votre prochaine réunion avec François Dupont est « Planning » le tomorrow 09:00.',
    mailAnswer: 'Nombre d’e-mails de François Dupont : 3.',
    hasEmailAnswer: 'Oui, l’adresse e-mail de François Dupont est francois@example.com.',
    noEmailAnswer: 'Non, aucune adresse e-mail n’est enregistrée pour François Dupont.',
  },
  {
    locale: 'pt',
    name: 'João da Silva',
    attribute: 'Qual é o e-mail de João da Silva?',
    calendar: 'Quando é a minha próxima reunião com João da Silva?',
    mail: 'Quantos e-mails eu tenho de João da Silva?',
    hasEmail: 'Tenho o e-mail de João da Silva?',
    mutation: 'Altere o e-mail de João da Silva.',
    attributeAnswer: 'O e-mail de João da Silva é joao@example.com.',
    calendarAnswer: 'Sua próxima reunião com João da Silva é “Planning” em tomorrow 09:00.',
    mailAnswer: 'Número de e-mails de João da Silva: 3.',
    hasEmailAnswer: 'Sim, o e-mail de João da Silva é joao@example.com.',
    noEmailAnswer: 'Não, não há nenhum e-mail salvo para João da Silva.',
  },
  {
    locale: 'ja',
    name: '山田太郎',
    attribute: '山田太郎のメールアドレスは？',
    calendar: '山田太郎との次の会議はいつですか？',
    mail: '山田太郎からのメールは何通ありますか？',
    hasEmail: '山田太郎のメールアドレスはありますか？',
    mutation: '山田太郎のメールアドレスを変更して。',
    attributeAnswer: '山田太郎のメールアドレスはtaro@example.comです。',
    calendarAnswer: '山田太郎との次の会議は「Planning」で、日時はtomorrow 09:00です。',
    mailAnswer: '山田太郎からのメール件数：3件。',
    hasEmailAnswer: 'はい、山田太郎のメールアドレスはtaro@example.comです。',
    noEmailAnswer: 'いいえ、山田太郎のメールアドレスは登録されていません。',
  },
  {
    locale: 'zh',
    name: '张伟',
    attribute: '请问张伟的邮箱是什么？',
    calendar: '与张伟的下次会议是什么时候？',
    mail: '来自张伟的邮件有多少封？',
    hasEmail: '有张伟的邮箱吗？',
    mutation: '修改张伟的邮箱。',
    attributeAnswer: '张伟的电子邮件地址是zhang@example.com。',
    calendarAnswer: '你与张伟的下次会议是“Planning”，时间为tomorrow 09:00。',
    mailAnswer: '来自张伟的邮件数量：3。',
    hasEmailAnswer: '有，张伟的电子邮件地址是zhang@example.com。',
    noEmailAnswer: '没有为张伟保存电子邮件地址。',
  },
];

const emailFor = (locale: SupportedLocale): string => ({
  de: 'joerg@example.com',
  es: 'maria@example.com',
  fr: 'francois@example.com',
  pt: 'joao@example.com',
  ja: 'taro@example.com',
  zh: 'zhang@example.com',
  en: 'english@example.com',
})[locale];

const match = async (
  matcher: TemplateMatcher,
  text: string,
): Promise<{
  readonly template: RenderTemplate;
  readonly slots: NonNullable<ReturnType<typeof extract>>['slots'];
  readonly locale: SupportedLocale;
}> => {
  const extraction = extract(text);
  if (extraction === null) throw new Error(`expected extraction for ${text}`);
  const template = await matcher({
    text,
    slots: extraction.slots,
    locale: extraction.locale,
    localeCandidates: extraction.localeCandidates,
  });
  if (template === null || template.kind !== 'render_template') {
    throw new Error(`expected render template for ${text}`);
  }
  return { template, slots: extraction.slots, locale: extraction.locale };
};

const probeAndRender = async (
  probe: DataPresenceProbe,
  template: RenderTemplate,
  slots: NonNullable<ReturnType<typeof extract>>['slots'],
  locale: SupportedLocale,
): Promise<string> => {
  const snapshot = await probe({ template, slots, locale });
  if (snapshot === null) throw new Error(`expected snapshot for ${template.template_hash}`);
  return await createTemplateRenderer()(snapshot.render_template_override ?? template, snapshot);
};

describe('multilingual deterministic gate', () => {
  it.each(CASES)('$locale extracts, matches, probes, and renders every read family', async (entry) => {
    const email = emailFor(entry.locale);
    const contact = {
      name: entry.name,
      email,
      emails: [email],
    };

    const attribute = await match(matchContactAttributeTemplate, entry.attribute);
    expect(attribute.locale).toBe(entry.locale);
    expect(attribute.template.template_hash).toContain(`-${entry.locale}@`);
    await expect(probeAndRender(
      createContactAttributePresenceProbe(() => [contact]),
      attribute.template,
      attribute.slots,
      entry.locale,
    )).resolves.toBe(entry.attributeAnswer);

    const calendar = await match(matchCalendarNextMeetingTemplate, entry.calendar);
    expect(calendar.locale).toBe(entry.locale);
    await expect(probeAndRender(
      createCalendarNextMeetingProbe(
        () => [contact],
        (_emails, locale) => {
          expect(locale).toBe(entry.locale);
          return { summary: 'Planning', when: 'tomorrow 09:00' };
        },
      ),
      calendar.template,
      calendar.slots,
      entry.locale,
    )).resolves.toBe(entry.calendarAnswer);

    const mail = await match(matchMailFromCountTemplate, entry.mail);
    expect(mail.locale).toBe(entry.locale);
    await expect(probeAndRender(
      createMailFromCountProbe(() => [contact], () => 3),
      mail.template,
      mail.slots,
      entry.locale,
    )).resolves.toBe(entry.mailAnswer);

    const hasEmail = await match(matchContactHasEmailTemplate, entry.hasEmail);
    expect(hasEmail.locale).toBe(entry.locale);
    await expect(probeAndRender(
      createContactHasEmailProbe(() => [contact], () => false, resolveContactHasNoEmailTemplate),
      hasEmail.template,
      hasEmail.slots,
      entry.locale,
    )).resolves.toBe(entry.hasEmailAnswer);

    await expect(probeAndRender(
      createContactHasEmailProbe(
        () => [{ name: entry.name, emails: [] }],
        () => false,
        resolveContactHasNoEmailTemplate,
      ),
      hasEmail.template,
      hasEmail.slots,
      entry.locale,
    )).resolves.toBe(entry.noEmailAnswer);
  });

  it.each(CASES)('$locale mutation cues fail closed', async (entry) => {
    const extraction = extract(entry.mutation);
    expect(extraction, entry.mutation).not.toBeNull();
    if (extraction === null) return;
    expect(await matchContactAttributeTemplate({
      text: entry.mutation,
      slots: extraction.slots,
      locale: extraction.locale,
      localeCandidates: extraction.localeCandidates,
    })).toBeNull();
  });

  it('keeps an English intent primary while extracting a Japanese name', async () => {
    const text = "What's 山田太郎's email?";
    const result = await match(matchContactAttributeTemplate, text);
    expect(result.locale).toBe('en');
    expect(result.slots.map((slot) => slot.value)).toEqual(['山田太郎']);
    expect(result.template.template_hash).toBe('recued/contact-email-by-name@v1');
  });

  it('uses the strongest intent language when one clause code-switches grammar', async () => {
    const text = "Dime María García's email?";
    const result = await match(matchContactAttributeTemplate, text);
    expect(result.locale).toBe('es');
    expect(result.slots.map((slot) => slot.value)).toEqual(['María García']);
    expect(result.template.template_hash).toBe('recued/contact-email-by-name-es@v1');

    const mutation = "cambia María García's email.";
    const extraction = extract(mutation);
    expect(extraction).not.toBeNull();
    if (extraction === null) return;
    expect(await matchContactAttributeTemplate({
      text: mutation,
      slots: extraction.slots,
      locale: extraction.locale,
      localeCandidates: extraction.localeCandidates,
    })).toBeNull();
  });

  it('uses script evidence only to widen extraction, never to choose response language', () => {
    expect(detectLanguages('山田太郎')).toEqual({
      locale: 'en',
      localeCandidates: ['en', 'ja', 'zh'],
    });
    expect(detectLanguages('María García')).toEqual({
      locale: 'en',
      localeCandidates: ['en', 'es', 'fr', 'pt'],
    });
  });

  it('treats terse Japanese possessive grammar as intent, not mere script evidence', async () => {
    const result = await match(matchContactAttributeTemplate, '山田太郎のメールアドレス？');
    expect(result.locale).toBe('ja');
    expect(result.template.template_hash).toBe('recued/contact-email-by-name-ja@v1');
  });

  it.each([
    ["Do I have 山田太郎's email?", matchContactHasEmailTemplate, 'recued/contact-has-email-by-name@v1'],
    ['Is there an email for 张伟?', matchContactHasEmailTemplate, 'recued/contact-has-email-by-name@v1'],
    ['Is there an email for Élodie Martin?', matchContactHasEmailTemplate, 'recued/contact-has-email-by-name@v1'],
    ["Can you tell me 山田太郎's email?", matchContactAttributeTemplate, 'recued/contact-email-by-name@v1'],
  ] as const)('keeps English intent primary across a foreign-script name: %s', async (
    text,
    matcher,
    expectedHash,
  ) => {
    const result = await match(matcher, text);
    expect(result.locale).toBe('en');
    expect(result.template.template_hash).toBe(expectedHash);
  });

  it.each([
    "changing Chang Wei's email.",
    "cámbiame María García's email.",
    "modifiez François Dupont's email.",
    "mude João da Silva's email.",
    "ersetze Jörg Müller's email.",
  ])('rejects inflected and clitic mutation verbs before a code-switched read shape: %s', async (text) => {
    expect(hasMutationIntent(text)).toBe(true);
    const extraction = extract(text);
    expect(extraction).not.toBeNull();
    if (extraction === null) return;
    expect(await matchContactAttributeTemplate({
      text,
      slots: extraction.slots,
      locale: extraction.locale,
      localeCandidates: extraction.localeCandidates,
    })).toBeNull();
  });

  it.each([
    "What's Chang Wei's email?",
    'Qual é o e-mail de Marcos Silva?',
  ])('does not confuse a contact name with a mutation stem: %s', (text) => {
    expect(hasMutationIntent(text)).toBe(false);
  });

  it.each([
    "How many emails do I have? What's Pat Lee's email?",
    "¿Cuántos correos tengo? What's 山田太郎's email?",
    "Tell me the weather and Pat Lee's email?",
    "Wie viele E-Mails: What's Pat Lee's email?",
    "Cuántos correos: What's Pat Lee's email?",
    "Combien de courriels: What's Pat Lee's email?",
    "Quantos e-mails: What's Pat Lee's email?",
    "何通のメール：What's Pat Lee's email?",
    "多少封邮件：What's Pat Lee's email?",
  ])('declines a valid possessive tail when its lead contains another request: %s', async (text) => {
    const extraction = extract(text);
    expect(extraction).not.toBeNull();
    if (extraction === null) return;
    expect(await matchContactAttributeTemplate({
      text,
      slots: extraction.slots,
      locale: extraction.locale,
      localeCandidates: extraction.localeCandidates,
    })).toBeNull();
  });

  it('declines a mixed-language prompt with two contact names', async () => {
    const text = "¿Cuál es el correo electrónico de María García? What's 山田太郎's email?";
    const extraction = extract(text);
    expect(extraction?.slots.filter((slot) => slot.kind === 'entity.name')).toHaveLength(2);
    if (extraction === null) return;
    expect(await matchContactAttributeTemplate({
      text,
      slots: extraction.slots,
      locale: extraction.locale,
      localeCandidates: extraction.localeCandidates,
    })).toBeNull();
  });
});
