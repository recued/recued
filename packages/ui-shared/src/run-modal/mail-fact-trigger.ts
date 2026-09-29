/** D-315 §5.1 — "A mail fact" on the run modal's Trigger tab: the pickers'
 *  options, the `triggers.create` arguments they make, and a fact trigger in
 *  words for the list.
 *
 *  A trigger is on one kind of email (ruling 43) or on any kind (ruling 42),
 *  and watches its variables — and, if it asks, every new email about the
 *  thing (ruling 44). On one kind, the pickers offer that kind's variables; on
 *  any kind, every variable a fact can have — the built-in kinds' and the
 *  owner's — once, labelled with the kinds that have it. The server validates
 *  and compiles the shorthand exactly as it compiles a recipe's
 *  `event_triggers` entry, so this module only offers what can match
 *  (variables of a filterable kind, and `complete`) and turns the picks into
 *  `{ on, fields, where }`; a refusal comes back with its reason. Pure. */

import {
  getMailFactBuiltinType,
  MAIL_FACT_BUILTIN_TYPES,
  MAIL_FACT_EVENT_PATTERN,
  MAIL_FACT_FILTERABLE_KINDS,
  MAIL_FACT_LAST_EMAIL_AT,
  mailFactOn,
  mailFactStoredId,
  mailFactStoredText,
  mailFactTypeVariables,
  type EventTrigger,
  type MailFactTypeSpec,
  type MailFactVariableKind,
} from '@recued/contracts';

import type { RunModalMailFactDraft, RunModalMailFactTemplate } from './types.js';

export const humanizeFactName = (value: string): string => {
  const spaced = value.replace(/_/g, ' ').trim();
  return spaced.length === 0 ? value : spaced[0]!.toUpperCase() + spaced.slice(1);
};

/** "a shipment", "an order received". */
export const withIndefiniteArticle = (noun: string): string => `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`;

/** An "only when" choice: a variable of a filterable kind, or `complete`.
 *  `values` lists what a closed kind can be (an enum's, or yes and no). */
export interface MailFactWhereOption {
  readonly name: string;
  readonly kind: MailFactVariableKind | 'complete';
  readonly values?: readonly string[];
}

/** One value a trigger can watch, with the kinds of email that have it. */
export interface MailFactVariableChoice {
  readonly name: string;
  /** The kinds that have it, by name, built-in first. */
  readonly kinds: readonly string[];
  /** Its "only when": absent when no kind can compare it (money, a file, the
   *  time of the newest email). */
  readonly where?: MailFactWhereOption;
}

/** A kind of email: built-in, or one the owner made (§4.5). */
export const mailFactTypeOf = (type: string, owned: readonly MailFactTypeSpec[] = []): MailFactTypeSpec | undefined =>
  getMailFactBuiltinType(type) ?? owned.find((candidate) => candidate.id === type);

/** The kinds a trigger may be on: one, or every one known (`type` null or
 *  not known). */
const kindsFor = (owned: readonly MailFactTypeSpec[], type: string | null): readonly MailFactTypeSpec[] => {
  const spec = type === null ? undefined : mailFactTypeOf(type, owned);
  return spec !== undefined ? [spec] : [...MAIL_FACT_BUILTIN_TYPES, ...owned];
};

/** Every value a trigger on this kind — or on any kind, `type` null — can
 *  watch: the variables, in the order the kinds declare them, then every new
 *  email about the thing (ruling 44). One name is one variable to a trigger:
 *  its "only when" takes an enum's values from every kind that has it, and a
 *  name whose kinds hold different things is typed as text. */
export const mailFactVocabulary = (
  owned: readonly MailFactTypeSpec[] = [],
  type: string | null = null,
): MailFactVariableChoice[] => {
  const kinds = kindsFor(owned, type);
  const found = new Map<string, { kinds: string[]; filterable: { kind: MailFactVariableKind; values?: readonly string[] }[] }>();
  for (const spec of kinds) {
    for (const variable of mailFactTypeVariables(spec)) {
      const entry = found.get(variable.name) ?? { kinds: [], filterable: [] };
      entry.kinds.push(spec.name);
      if (MAIL_FACT_FILTERABLE_KINDS.has(variable.kind)) {
        entry.filterable.push({ kind: variable.kind, ...(variable.values !== undefined ? { values: variable.values } : {}) });
      }
      found.set(variable.name, entry);
    }
  }
  const variables = [...found].map(([name, { kinds: having, filterable }]): MailFactVariableChoice => {
    if (filterable.length === 0) return { name, kinds: having };
    const same = filterable.every((declared) => declared.kind === filterable[0]!.kind);
    const kind = same ? filterable[0]!.kind : 'text';
    const where: MailFactWhereOption = kind === 'enum'
      ? { name, kind, values: [...new Set(filterable.flatMap((declared) => declared.values ?? []))] }
      : kind === 'boolean' ? { name, kind, values: ['true', 'false'] } : { name, kind };
    return { name, kinds: having, where };
  });
  return [...variables, { name: MAIL_FACT_LAST_EMAIL_AT, kinds: kinds.map((spec) => spec.name) }];
};

/** A choice as the owner reads it. On any kind it says which kinds have it:
 *  "Order id — purchase, shipment, order received", "State — every kind of
 *  email"; on one kind, its name alone. */
export const mailFactChoiceLabel = (
  choice: MailFactVariableChoice,
  owned: readonly MailFactTypeSpec[] = [],
  type: string | null = null,
): string => {
  if (choice.name === MAIL_FACT_LAST_EMAIL_AT) return 'A new email about it, even when nothing else changed';
  if (type !== null && mailFactTypeOf(type, owned) !== undefined) return humanizeFactName(choice.name);
  const all = MAIL_FACT_BUILTIN_TYPES.length + owned.length;
  const kinds = choice.kinds.length === all ? 'every kind of email' : choice.kinds.map((kind) => kind.toLowerCase()).join(', ');
  return `${humanizeFactName(choice.name)} — ${kinds}`;
};

const COMPLETE: MailFactWhereOption = { name: 'complete', kind: 'complete', values: ['true', 'false'] };

/** What "only when" can test on this kind (or any, `type` null): every
 *  variable it can compare, and whether every required value was read. */
export const mailFactWhereOptions = (
  owned: readonly MailFactTypeSpec[] = [],
  type: string | null = null,
): MailFactWhereOption[] => [
  ...mailFactVocabulary(owned, type).flatMap((choice) => (choice.where !== undefined ? [choice.where] : [])),
  COMPLETE,
];

/** A typed value as the fact stores it (`normalize.ts`): text as
 *  `mailFactStoredText` writes it (canonical, its spaces collapsed — a
 *  fullwidth `Ｓｈｏｐ` is `Shop`), an id as `mailFactStoredId` does (`#112-3345`
 *  is `112-3345`), a number parsed, yes or no a boolean — or why it cannot be one. */
export const mailFactWhereValue = (
  option: MailFactWhereOption,
  raw: string,
): { value: string | number | boolean } | { error: string } => {
  if (option.kind === 'complete' || option.kind === 'boolean') {
    return raw === 'true' || raw === 'false' ? { value: raw === 'true' } : { error: 'Choose yes or no.' };
  }
  const label = humanizeFactName(option.name);
  const text = option.kind === 'id' ? mailFactStoredId(raw) : mailFactStoredText(raw);
  if (text === '') return { error: `Say which ${label.toLowerCase()} it must be.` };
  if (option.kind !== 'number') return { value: text };
  const number = Number(text);
  return Number.isFinite(number) ? { value: number } : { error: `${label} must be a number.` };
};

/** The values whose change can wake the trigger. */
export const mailFactFieldOptions = (owned: readonly MailFactTypeSpec[] = [], type: string | null = null): string[] =>
  mailFactVocabulary(owned, type).map((choice) => choice.name);

/** The picks as `triggers.create` takes them, or why they cannot be sent. */
export const mailFactCreateArgs = (
  draft: RunModalMailFactDraft,
  owned: readonly MailFactTypeSpec[] = [],
): { on: string; fields?: string[]; where?: Record<string, string | number | boolean> } | { error: string } => {
  const type = draft.type === '' ? null : draft.type;
  if (type !== null && mailFactTypeOf(type, owned) === undefined) return { error: 'Choose a kind of email.' };
  const where: Record<string, string | number | boolean> = {};
  if (draft.where_variable !== '') {
    const option = mailFactWhereOptions(owned, type).find((candidate) => candidate.name === draft.where_variable);
    if (option === undefined) return { error: 'Choose what the fact must say.' };
    const typed = mailFactWhereValue(option, draft.where_value);
    if ('error' in typed) return typed;
    where[option.name] = typed.value;
  }
  if (draft.template_id !== '') where.template = draft.template_id;
  return {
    on: mailFactOn(type),
    ...(draft.fields.length > 0 ? { fields: [...draft.fields] } : {}),
    ...(Object.keys(where).length > 0 ? { where } : {}),
  };
};

/** A trigger on one kind of email: its pattern names the kind. */
const KIND_PATTERN = /^data\.mail_fact\.([a-z0-9_]+)\.thing\.\*$/;

/** A fact trigger in words — `null` for any other trigger. */
export const describeMailFactTrigger = (
  trigger: Pick<EventTrigger, 'pattern' | 'fields' | 'filter'>,
  templates: readonly RunModalMailFactTemplate[] | null,
  owned: readonly MailFactTypeSpec[] = [],
): string | null => {
  const type = trigger.pattern === MAIL_FACT_EVENT_PATTERN ? null : KIND_PATTERN.exec(trigger.pattern)?.[1];
  if (type === undefined) return null;
  const spec = type === null ? undefined : mailFactTypeOf(type, owned);
  const kinds = new Map(mailFactWhereOptions(owned, type).map((option) => [option.name, option.kind]));
  const parts = [type === null
    ? 'a fact read from mail'
    : `${withIndefiniteArticle((spec?.name ?? humanizeFactName(type.replace(/^custom_/, ''))).toLowerCase())} read from mail`];
  const watched = (trigger.fields ?? []).filter((field) => field !== MAIL_FACT_LAST_EMAIL_AT);
  const everyEmail = (trigger.fields ?? []).includes(MAIL_FACT_LAST_EMAIL_AT);
  parts.push(watched.length > 0
    ? `when ${watched.map((field) => humanizeFactName(field).toLowerCase()).join(' or ')} changes${everyEmail ? ' or a new email arrives' : ''}`
    : everyEmail ? 'on every new email about it' : 'on every change');
  for (const [key, value] of Object.entries(trigger.filter ?? {})) {
    const field = key.replace(/^record\./, '');
    if (field === 'template') {
      // A narrowing to a template that is off, or gone, can wait forever: say so.
      const template = templates?.find((candidate) => candidate.template_id === value);
      parts.push(templates === null
        ? 'read by one template'
        : template === undefined
          ? 'read by a template that was deleted'
          : `read by “${template.name}”${template.active === false ? ', which is off' : ''}`);
    } else if (field === 'complete') {
      parts.push(value === true ? 'only when complete' : 'only when a value is missing');
    } else {
      // An enum value is a name; anything else is what the owner wrote.
      const said = typeof value === 'boolean'
        ? (value ? 'yes' : 'no')
        : kinds.get(field) === 'enum' ? humanizeFactName(String(value)).toLowerCase()
          : typeof value === 'string' ? `“${value}”` : String(value);
      parts.push(`only when ${humanizeFactName(field).toLowerCase()} is ${said}`);
    }
  }
  return parts.join(', ');
};
