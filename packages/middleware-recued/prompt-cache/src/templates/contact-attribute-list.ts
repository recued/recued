/** Deterministic bounded multi-contact attribute reads.
 *
 * Only a complete 2..5-name conjunction list in one fully anchored read form
 * is accepted. A distinct template is minted per list cardinality so the
 * declared slot grammar remains truthful; missing/ambiguous contacts or one
 * missing value make the probe defer the whole answer. */

import { totalRecord } from '@recued/contracts';
import type { SlotValue } from '../ner/index.js';
import type { TemplateMatcher } from '../gate/index.js';
import type { RenderTemplate } from '../types.js';
import {
  escapeTemplateRegExp,
  hasMutationIntent,
  LOCALIZED_TAIL,
  normaliseTemplateText,
  resolveTemplateLocale,
  type SupportedLocale,
} from './locales.js';
import type { ContactAttribute } from './contact-attribute.js';

export const CONTACT_ATTRIBUTE_LIST_MIN = 2;
export const CONTACT_ATTRIBUTE_LIST_MAX = 5;

type ContactListCount = 2 | 3 | 4 | 5;
const CONTACT_LIST_COUNTS = [2, 3, 4, 5] as const;
// ⚠ No `: readonly ContactAttribute[]` annotation — it would widen the `as const`
// and make `totalRecord`'s key inference (and the proof below) vacuous.
const CONTACT_ATTRIBUTES = [
  'email',
  'phone',
  'company',
  'title',
  'birthday',
] as const satisfies readonly ContactAttribute[];

/** Compile-time proof the list covers the union — what keeps `totalRecord`
 *  sound here rather than an assertion. */
type ContactAttributesAreExhaustive =
  Exclude<ContactAttribute, (typeof CONTACT_ATTRIBUTES)[number]> extends never ? true : never;
const _contactAttributesAreExhaustive: ContactAttributesAreExhaustive = true;
void _contactAttributesAreExhaustive;

export interface ContactAttributeListTemplateDescriptor {
  readonly attribute: ContactAttribute;
  readonly slotCount: ContactListCount;
}

type AttributeListTemplates = Readonly<
  Record<ContactAttribute, Readonly<Record<ContactListCount, RenderTemplate>>>
>;

const HEADINGS: Readonly<Record<SupportedLocale, Readonly<Record<ContactAttribute, string>>>> = {
  en: {
    email: 'Email addresses:',
    phone: 'Phone numbers:',
    company: 'Employers:',
    title: 'Job titles:',
    birthday: 'Birthdays:',
  },
  de: {
    email: 'E-Mail-Adressen:',
    phone: 'Telefonnummern:',
    company: 'Arbeitgeber:',
    title: 'Berufsbezeichnungen:',
    birthday: 'Geburtstage:',
  },
  es: {
    email: 'Correos electrónicos:',
    phone: 'Números de teléfono:',
    company: 'Empleadores:',
    title: 'Cargos:',
    birthday: 'Cumpleaños:',
  },
  fr: {
    email: 'Adresses e-mail :',
    phone: 'Numéros de téléphone :',
    company: 'Employeurs :',
    title: 'Postes :',
    birthday: 'Dates d’anniversaire :',
  },
  ja: {
    email: 'メールアドレス：',
    phone: '電話番号：',
    company: '勤務先：',
    title: '役職：',
    birthday: '誕生日：',
  },
  pt: {
    email: 'E-mails:',
    phone: 'Números de telefone:',
    company: 'Empregadores:',
    title: 'Cargos:',
    birthday: 'Aniversários:',
  },
  zh: {
    email: '电子邮件地址：',
    phone: '电话号码：',
    company: '公司：',
    title: '职位：',
    birthday: '生日：',
  },
};

const templatesForLocale = (locale: SupportedLocale): AttributeListTemplates => {
  return totalRecord(CONTACT_ATTRIBUTES, (attribute) =>
    totalRecord(CONTACT_LIST_COUNTS, (count): RenderTemplate => {
      return {
        template_hash: `recued/contact-${attribute}-by-name-list-${count}-${locale}@v1`,
        kind: 'render_template',
        slot_grammar: Array.from({ length: count }, () => 'entity.name'),
        action_class: 'read',
        short_circuit_eligible: true,
        body: `${HEADINGS[locale][attribute]}\n{{items}}`,
      };
    }));
};

export const CONTACT_ATTRIBUTE_LIST_TEMPLATES_BY_LOCALE: Readonly<
  Record<SupportedLocale, AttributeListTemplates>
> = {
  en: templatesForLocale('en'),
  de: templatesForLocale('de'),
  es: templatesForLocale('es'),
  fr: templatesForLocale('fr'),
  ja: templatesForLocale('ja'),
  pt: templatesForLocale('pt'),
  zh: templatesForLocale('zh'),
};

export const CONTACT_ATTRIBUTE_LIST_TEMPLATE_DESCRIPTORS: ReadonlyMap<
  string,
  ContactAttributeListTemplateDescriptor
> = new Map(
  (Object.values(CONTACT_ATTRIBUTE_LIST_TEMPLATES_BY_LOCALE) as AttributeListTemplates[])
    .flatMap((templates) => CONTACT_ATTRIBUTES.flatMap((attribute) =>
      CONTACT_LIST_COUNTS.map((slotCount) => [
        templates[attribute][slotCount].template_hash,
        { attribute, slotCount },
      ] as const))),
);

const orderedNameSlots = (slots: ReadonlyArray<SlotValue>): readonly SlotValue[] | null => {
  if (
    slots.length < CONTACT_ATTRIBUTE_LIST_MIN
    || slots.length > CONTACT_ATTRIBUTE_LIST_MAX
    || slots.some((slot) => slot.kind !== 'entity.name')
  ) return null;
  const ordered = [...slots].sort((a, b) => a.position - b.position);
  for (let i = 1; i < ordered.length; i += 1) {
    const prior = ordered[i - 1]!;
    if (prior.position + prior.raw.length > ordered[i]!.position) return null;
  }
  return ordered;
};

const latinListPattern = (
  names: readonly string[],
  conjunction: string,
  oxfordComma: boolean,
): string => {
  if (names.length === 2) return `${names[0]}\\s+${conjunction}\\s+${names[1]}`;
  const lead = names.slice(0, -1).join(',\\s+');
  return `${lead}${oxfordComma ? ',' : ''}\\s+${conjunction}\\s+${names.at(-1)!}`;
};

const contactListPattern = (
  locale: SupportedLocale,
  slots: readonly SlotValue[],
): string => {
  const names = slots.map((slot) =>
    escapeTemplateRegExp(normaliseTemplateText(slot.raw)));
  if (locale === 'ja') {
    return names.length === 2
      ? `${names[0]}\\s*と\\s*${names[1]}`
      : `${names.slice(0, -1).join('\\s*、\\s*')}\\s*と\\s*${names.at(-1)!}`;
  }
  if (locale === 'zh') {
    return names.length === 2
      ? `${names[0]}\\s*和\\s*${names[1]}`
      : `${names.slice(0, -1).join('\\s*、\\s*')}\\s*和\\s*${names.at(-1)!}`;
  }
  const conjunction = locale === 'de'
    ? 'und'
    : locale === 'es'
      ? 'y'
      : locale === 'fr'
        ? 'et'
        : locale === 'pt'
          ? 'e'
          : 'and';
  return latinListPattern(names, conjunction, locale === 'en');
};

const localizedAttributeListPattern = (
  locale: SupportedLocale,
  attribute: ContactAttribute,
  list: string,
): RegExp => {
  const tail = LOCALIZED_TAIL;
  if (locale === 'ja') {
    const noun = {
      email: 'メール(?:アドレス)?',
      phone: '電話番号',
      company: '(?:勤務先|会社)',
      title: '役職',
      birthday: '誕生日',
    }[attribute];
    return new RegExp(`^${list}の${noun}(?:を)?(?:教えて|確認して)${tail}`, 'u');
  }
  if (locale === 'zh') {
    const noun = {
      email: '(?:邮箱|电子邮件地址?)',
      phone: '(?:电话号码|手机号)',
      company: '(?:公司|雇主)',
      title: '(?:职位|职务)',
      birthday: '生日',
    }[attribute];
    return new RegExp(`^(?:请)?(?:告诉我|列出)${list}的${noun}${tail}`, 'u');
  }
  const prefix: Readonly<Record<Exclude<SupportedLocale, 'ja' | 'zh'>, Readonly<Record<ContactAttribute, string>>>> = {
    en: {
      email: '(?:what are|show me|list)\\s+(?:the\\s+)?email\\s+addresses\\s+for',
      phone: '(?:what are|show me|list)\\s+(?:the\\s+)?phone\\s+numbers\\s+for',
      company: '(?:what are|show me|list)\\s+(?:the\\s+)?(?:companies|employers)\\s+for',
      title: '(?:what are|show me|list)\\s+(?:the\\s+)?job\\s+titles\\s+for',
      birthday: '(?:what are|show me|list)\\s+(?:the\\s+)?birthdays\\s+for',
    },
    de: {
      email: 'wie lauten\\s+(?:die\\s+)?e-?mail-adressen\\s+von',
      phone: 'wie lauten\\s+(?:die\\s+)?telefonnummern\\s+von',
      company: 'wer sind\\s+(?:die\\s+)?arbeitgeber\\s+von',
      title: 'wie lauten\\s+(?:die\\s+)?berufsbezeichnungen\\s+von',
      birthday: 'wann sind\\s+(?:die\\s+)?geburtstage\\s+von',
    },
    es: {
      email: '[¿¡]?\\s*cu[aá]les son\\s+(?:los\\s+)?correos electr[oó]nicos\\s+de',
      phone: '[¿¡]?\\s*cu[aá]les son\\s+(?:los\\s+)?n[uú]meros de tel[eé]fono\\s+de',
      company: '[¿¡]?\\s*cu[aá]les son\\s+(?:los\\s+)?empleadores\\s+de',
      title: '[¿¡]?\\s*cu[aá]les son\\s+(?:los\\s+)?cargos\\s+de',
      birthday: '[¿¡]?\\s*cu[aá]ndo son\\s+(?:los\\s+)?cumplea[nñ]os\\s+de',
    },
    fr: {
      email: 'quelles sont\\s+(?:les\\s+)?adresses e-?mail\\s+de',
      phone: 'quels sont\\s+(?:les\\s+)?num[eé]ros de t[eé]l[eé]phone\\s+de',
      company: 'quels sont\\s+(?:les\\s+)?employeurs\\s+de',
      title: 'quels sont\\s+(?:les\\s+)?postes\\s+de',
      birthday: 'quelles sont\\s+(?:les\\s+)?dates d[’\']anniversaire\\s+de',
    },
    pt: {
      email: 'quais s[aã]o\\s+(?:os\\s+)?e-?mails\\s+de',
      phone: 'quais s[aã]o\\s+(?:os\\s+)?n[uú]meros de telefone\\s+de',
      company: 'quais s[aã]o\\s+(?:os\\s+)?empregadores\\s+de',
      title: 'quais s[aã]o\\s+(?:os\\s+)?cargos\\s+de',
      birthday: 'quando s[aã]o\\s+(?:os\\s+)?anivers[aá]rios\\s+de',
    },
  };
  return new RegExp(`^${prefix[locale][attribute]}\\s+${list}${tail}`, 'u');
};

export const matchContactAttributeListTemplate: TemplateMatcher = ({ text, slots, locale }) => {
  const ordered = orderedNameSlots(slots);
  if (ordered === null) return null;
  const templateLocale = resolveTemplateLocale(locale);
  const haystack = normaliseTemplateText(text);
  if (hasMutationIntent(haystack)) return null;
  const list = contactListPattern(templateLocale, ordered);
  const templates = CONTACT_ATTRIBUTE_LIST_TEMPLATES_BY_LOCALE[templateLocale];
  const count = ordered.length as ContactListCount;
  for (const attribute of CONTACT_ATTRIBUTES) {
    if (localizedAttributeListPattern(templateLocale, attribute, list).test(haystack)) {
      return templates[attribute][count];
    }
  }
  return null;
};
