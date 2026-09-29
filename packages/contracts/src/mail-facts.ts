/**
 * D-315 — Mail facts: the owner teaches Recued to read a kind of email, and the
 * result is a trigger. This module is the CONTRACT half: the built-in fact
 * types, the template shape, the fact and thing records, the event vocabulary,
 * and a pure structural validator for templates.
 *
 * Vocabulary (spec §0):
 *   - a **fact** is one typed record taken from one email. It has **variables**
 *     (the few typed values a trigger tests, always present, `null` when unread)
 *     and **data** (anything else, any shape, for the recipe to process);
 *   - a fact exists only once its template's **entrance** is met: the template's
 *     conditions hold and its entrance variables were read by rules;
 *   - facts about one parcel, order or booking make one **thing**, found by the
 *     type's **identity**. A recipe subscribes to changes of a thing's variables.
 *
 * Spec: D-315 §3, §3.1, §3.2, §4, §5, §5.1.
 */

import type { RunAnchorStatus } from './commits.js';
import { NETWORK_DOMAINS } from './contact-identity.js';

// ────────────────────────────────────────────────────────────────
// Variable kinds (§3.2)
// ────────────────────────────────────────────────────────────────

/** The kinds a variable can have. The core checks a value against its kind at
 *  write (a date is a date, an enum value is one the variable declares); a
 *  format particular to a sender or carrier is the recipe's to check (ruling 41). */
export const MAIL_FACT_VARIABLE_KINDS = [
  'text',
  'number',
  'boolean',
  'enum',
  /** `{ amount, currency }` — amount a decimal string, currency ISO 4217. */
  'money',
  /** `YYYY-MM-DD`. */
  'date',
  /** ISO 8601: with its zone when the email states one
   *  (`2026-09-26T14:30:00Z`), else a local time without an offset — a
   *  check-in at 3 pm is the venue's time, which no offset of ours knows. */
  'datetime',
  /** A normalized identifier (`mailFactStoredId`): no leading `#`, `:` or
   *  `.`, no trailing punctuation, no whitespace. */
  'id',
  /** A file record id: the attachment a template picked by name or type. */
  'file',
] as const;
export type MailFactVariableKind = (typeof MAIL_FACT_VARIABLE_KINDS)[number];
export const MAIL_FACT_VARIABLE_KIND_SET: ReadonlySet<MailFactVariableKind> = new Set(
  MAIL_FACT_VARIABLE_KINDS,
);

/** The scalar kinds a trigger's `where` can compare by equality. Money is an
 *  object and a file is an opaque id, so neither is filterable; nor is a
 *  date-time: a fact stores it to the second with its zone, so no value typed
 *  into a filter meets one — watch it with `fields` instead. */
export const MAIL_FACT_FILTERABLE_KINDS: ReadonlySet<MailFactVariableKind> = new Set([
  'text',
  'number',
  'boolean',
  'enum',
  'date',
  'id',
]);

/** Text as every reader, detector and identity key reads it (§9), and every
 *  template, trigger and fact names it: in its compatibility form (NFKC) — a
 *  fullwidth `４` or a mathematical bold four is a `4`, and `ﬁ` is `fi` —
 *  without what shows nothing (a zero-width space, a direction mark, a soft
 *  hyphen), with any space a space and a hyphen a hyphen; a line stays a line,
 *  for the readers that read lines. Read each its own way, a card in fullwidth
 *  digits passed one detector and was plain in another's key, and a date with
 *  a zero-width space in it was no date at all. A dash other than a hyphen
 *  stays as written: a range's en dash and an offset's minus sign are told
 *  apart by the reader that reads them. */
export const canonicalMailFactText = (text: string): string =>
  text
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/[\u2028\u2029]/g, '\n')
    .replace(/[^\S\n\r]/g, ' ')
    .replace(/\u2010/g, '-');

/** Text as a fact stores it (`normalize.ts`): canonical, on one line — its
 *  spaces collapsed, none at either end. A trigger's `where` must name it so. */
export const mailFactStoredText = (text: string): string =>
  canonicalMailFactText(text).replace(/\s+/g, ' ').trim();

/** A template's pattern as it runs (§4.2): over canonical text, so each
 *  character it was written with is read as the text is — the fullwidth `：`
 *  of `注文番号：(\S+)` is the `:` the email now holds. Only what it matches
 *  changes: a character canonical form changes is written as the literal it
 *  stands for, so a fullwidth `（` is still a character to match, never a
 *  group; and one that shows nothing is an empty group outside a class, so no
 *  quantifier after it moves onto the character before. */
export const canonicalMailFactPattern = (pattern: string): string => {
  const literal = (char: string, inClass: boolean): string => {
    const canonical = canonicalMailFactText(char);
    if (canonical === char) return char;
    if (canonical.length === 0) return inClass ? '' : '(?:)';
    let out = '';
    for (let i = 0; i < canonical.length; i += 1) out += `\\u${canonical.charCodeAt(i).toString(16).padStart(4, '0')}`;
    return out;
  };
  const chars = [...pattern];
  let out = '';
  let inClass = false;
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i]!;
    if (char === '\\' && i + 1 < chars.length) {
      i += 1;
      const escaped = chars[i]!;
      // An escaped character past ASCII stands for itself.
      out += escaped.charCodeAt(0) < 0x80 ? `\\${escaped}` : literal(escaped, inClass);
    } else if (char.charCodeAt(0) < 0x80) {
      if (char === '[') inClass = true;
      else if (char === ']') inClass = false;
      out += char;
    } else {
      out += literal(char, inClass);
    }
  }
  return out;
};

/** An id as a fact stores it (`normalize.ts`): canonical, with no leading
 *  `#`, `:`, `.` or dash, no trailing punctuation, no spaces — `#112-3345` is
 *  `112-3345`, and `Ref:-4471` read after its label is `4471` (no id has a
 *  sign). A trigger's `where` must name it so, or it could never match. */
export const mailFactStoredId = (text: string): string =>
  canonicalMailFactText(text).replace(/^[#:.\s-]+|[.,;:\s]+$/g, '').replace(/\s+/g, '');

export interface MailFactMoney {
  /** A decimal string: never parsed to a float, which would round money. */
  readonly amount: string;
  /** ISO 4217, upper case. */
  readonly currency: string;
}

/** A variable's value. `null` means no pass read it. */
export type MailFactValue = string | number | boolean | MailFactMoney;

export interface MailFactVariableSpec {
  readonly name: string;
  readonly kind: MailFactVariableKind;
  /** A required variable is in the type's default entrance, and `complete`
   *  means every required variable was read. */
  readonly required: boolean;
  /** Declared values, for `kind: 'enum'`. */
  readonly values?: readonly string[];
  /** What the variable holds, for the template editor and the AI. */
  readonly description?: string;
}

/** A declared data field: a hint for the template editor and the AI, never a
 *  trigger field (ruling 24). Undeclared data passes through as it came. */
export interface MailFactDataFieldSpec {
  readonly path: string;
  readonly kind: MailFactVariableKind | 'list' | 'object';
  readonly description?: string;
}

// ────────────────────────────────────────────────────────────────
// Types (§3.1)
// ────────────────────────────────────────────────────────────────

/** A type's shape with its id as a plain string: what the built-in catalog is
 *  checked against (declared apart from `MailFactTypeSpec`, whose id type is
 *  derived FROM the catalog, so the check does not refer to itself). */
export interface MailFactTypeSpecDraft {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** The declared variables, WITHOUT the implicit `state` / `notice` (see
   *  `mailFactTypeVariables`). */
  readonly variables: readonly MailFactVariableSpec[];
  /** Where the thing now is (`delivered`, `paid`). A notice never changes it. */
  readonly states: readonly string[];
  /** Something said about the thing (`reminder`, `changed`). */
  readonly notices: readonly string[];
  /** One thing across emails: alternatives, each a list of variables. A fact
   *  forms a key from every alternative whose variables were all read, and joins
   *  the thing that shares any of them. */
  readonly identity: readonly (readonly string[])[];
  readonly data_fields?: readonly MailFactDataFieldSpec[];
}

export interface MailFactTypeSpec extends Omit<MailFactTypeSpecDraft, 'id'> {
  readonly id: MailFactTypeId;
}

const v = (
  name: string,
  kind: MailFactVariableKind,
  required: boolean,
  extra: Partial<Pick<MailFactVariableSpec, 'values' | 'description'>> = {},
): MailFactVariableSpec => ({ name, kind, required, ...extra });

export const MAIL_FACT_RESERVATION_KINDS = [
  'lodging',
  'transport',
  'event',
  'dining',
  'appointment',
  'car',
] as const;

export const MAIL_FACT_PAY_TAX_DOCUMENT_KINDS = ['payslip', 'tax_form'] as const;

/** The built-in types (§3.1). Deadlines are not built-in variables (ruling 35):
 *  a template that knows its sender's deadline reads it into data. */
export const MAIL_FACT_BUILTIN_TYPES = [
  {
    id: 'purchase',
    name: 'Purchase',
    description: 'An order you placed or paid.',
    variables: [
      v('merchant', 'text', true),
      v('order_id', 'id', true),
      v('total', 'money', true),
      v('ordered_at', 'date', true),
    ],
    states: ['ordered', 'paid', 'cancelled'],
    notices: [],
    identity: [['merchant', 'order_id']],
    data_fields: [{ path: 'items', kind: 'list', description: 'Line items.' }],
  },
  {
    id: 'shipment',
    name: 'Shipment',
    description: 'A parcel coming to you.',
    variables: [
      v('carrier', 'text', true),
      v('tracking_number', 'id', true),
      v('order_id', 'id', false),
      v('merchant', 'text', false),
      v('expected_at', 'date', false),
      v('delivered_at', 'datetime', false),
    ],
    states: ['label_created', 'in_transit', 'out_for_delivery', 'delivered', 'exception', 'returned'],
    notices: [],
    identity: [['carrier', 'tracking_number']],
  },
  {
    id: 'return_refund',
    name: 'Return or refund',
    description: 'Something going back, or money coming back.',
    variables: [
      v('merchant', 'text', true),
      v('order_id', 'id', false),
      v('return_id', 'id', false),
      v('amount', 'money', false),
    ],
    states: ['return_requested', 'label_issued', 'received', 'refund_issued', 'refund_denied'],
    notices: [],
    identity: [
      ['merchant', 'return_id'],
      ['merchant', 'order_id'],
    ],
  },
  {
    id: 'reservation',
    name: 'Reservation',
    description: 'A booking with a time and a place.',
    variables: [
      v('kind', 'enum', true, { values: MAIL_FACT_RESERVATION_KINDS }),
      v('provider', 'text', true),
      v('confirmation_code', 'id', true),
      v('starts_at', 'datetime', true),
      v('ends_at', 'datetime', false),
      v('location', 'text', false),
      v('party_size', 'number', false),
      v('total', 'money', false),
    ],
    states: ['confirmed', 'cancelled'],
    notices: ['changed', 'reminder'],
    identity: [['provider', 'confirmation_code']],
  },
  {
    id: 'bill',
    name: 'Bill',
    description: 'Money owed by a date.',
    variables: [
      v('issuer', 'text', true),
      v('amount_due', 'money', true),
      v('due_at', 'date', true),
      v('invoice_number', 'id', false),
      v('period', 'text', false),
      v('account_ref', 'text', false, { description: 'The last four characters only.' }),
      v('document', 'file', false),
    ],
    states: ['issued', 'paid', 'overdue'],
    notices: ['reminder'],
    identity: [
      ['issuer', 'invoice_number'],
      ['issuer', 'period'],
    ],
  },
  {
    id: 'statement',
    name: 'Statement',
    description: 'A periodic account statement.',
    variables: [
      v('issuer', 'text', true),
      v('account_ref', 'text', true, { description: 'The last four characters only.' }),
      v('period_start', 'date', true),
      v('period_end', 'date', true),
      v('closing_balance', 'money', false),
      v('minimum_due', 'money', false),
      v('due_at', 'date', false),
      v('document', 'file', false),
    ],
    states: ['available'],
    notices: [],
    identity: [['issuer', 'account_ref', 'period_end']],
  },
  {
    id: 'subscription',
    name: 'Subscription',
    description: 'A recurring charge.',
    variables: [
      v('service', 'text', true),
      v('plan', 'text', false),
      v('amount', 'money', false),
      v('renews_at', 'date', false),
    ],
    states: ['active', 'cancelled'],
    notices: ['renewal', 'price_change', 'trial_ending', 'payment_failed'],
    identity: [['service']],
  },
  {
    id: 'pay_tax_document',
    name: 'Payslip or tax form',
    description: 'A payslip or a tax form.',
    variables: [
      v('issuer', 'text', true),
      v('kind', 'enum', true, { values: MAIL_FACT_PAY_TAX_DOCUMENT_KINDS }),
      v('period_or_year', 'text', true),
      v('document', 'file', false),
    ],
    states: ['available'],
    notices: [],
    identity: [['issuer', 'kind', 'period_or_year']],
  },
  {
    id: 'lead',
    name: 'Lead',
    description: 'Someone asking about your business.',
    variables: [
      v('source', 'text', true),
      v('name', 'text', false),
      v('email', 'text', false),
      v('phone', 'text', false),
      v('reference', 'id', false),
    ],
    states: ['new'],
    notices: [],
    identity: [['source', 'reference', 'email']],
    data_fields: [{ path: 'message', kind: 'text', description: 'What they asked.' }],
  },
  {
    id: 'order_received',
    name: 'Order received',
    description: 'Someone bought from you.',
    variables: [
      v('platform', 'text', true),
      v('order_id', 'id', true),
      v('buyer_name', 'text', false),
      v('buyer_email', 'text', false),
      v('total', 'money', true),
      v('ship_by', 'date', false),
    ],
    states: ['new', 'paid', 'cancelled'],
    notices: [],
    identity: [['platform', 'order_id']],
    data_fields: [{ path: 'items', kind: 'list', description: 'Line items.' }],
  },
  {
    id: 'owner_request',
    name: 'Request to your server',
    description: 'A request you emailed to your own +tag address (§7.4).',
    variables: [v('tag', 'text', true), v('message_id', 'id', true)],
    states: ['new'],
    notices: [],
    identity: [['message_id']],
    data_fields: [
      { path: 'request', kind: 'text', description: 'The request text.' },
      { path: 'thread', kind: 'object', description: 'The thread, when the tag was CC’d onto one.' },
    ],
  },
] as const satisfies readonly MailFactTypeSpecDraft[];

export type MailFactBuiltinTypeId = (typeof MAIL_FACT_BUILTIN_TYPES)[number]['id'];
export type MailFactCustomTypeId = `custom_${string}`;
export type MailFactTypeId = MailFactBuiltinTypeId | MailFactCustomTypeId;

export const MAIL_FACT_BUILTIN_TYPE_IDS: readonly MailFactBuiltinTypeId[] =
  MAIL_FACT_BUILTIN_TYPES.map((t) => t.id);
export const MAIL_FACT_BUILTIN_TYPE_ID_SET: ReadonlySet<string> = new Set(MAIL_FACT_BUILTIN_TYPE_IDS);

export const isMailFactBuiltinTypeId = (value: unknown): value is MailFactBuiltinTypeId =>
  typeof value === 'string' && MAIL_FACT_BUILTIN_TYPE_ID_SET.has(value);

/** An owner type's id (§4.5): `custom_` then `[a-z0-9_]`, at most 40 characters.
 *  Its id is a segment of an event path, so a dot or any other character would
 *  make a pattern the reconciler silently skips. */
export const MAIL_FACT_CUSTOM_TYPE_ID_RE = /^custom_[a-z0-9_]{1,40}$/;

export const isMailFactCustomTypeId = (value: unknown): value is MailFactCustomTypeId =>
  typeof value === 'string' && MAIL_FACT_CUSTOM_TYPE_ID_RE.test(value);

export const isMailFactTypeId = (value: unknown): value is MailFactTypeId =>
  isMailFactBuiltinTypeId(value) || isMailFactCustomTypeId(value);

export const getMailFactBuiltinType = (id: string): MailFactTypeSpec | undefined =>
  MAIL_FACT_BUILTIN_TYPES.find((t) => t.id === id) as MailFactTypeSpec | undefined;

/** The implicit variables every type carries, beside its declared ones. */
export const MAIL_FACT_STATE_VARIABLE = 'state';
export const MAIL_FACT_NOTICE_VARIABLE = 'notice';

/** The four carriers a parcel's carrier is named as, with the names each goes
 *  by in running text (§7.1). Every pass stores a `carrier` that names one of
 *  them under this name, so one parcel is one thing (its identity is carrier +
 *  tracking number), and a trigger's `where.carrier` must be written so too. */
export const MAIL_FACT_CARRIERS = ['UPS', 'USPS', 'FedEx', 'DHL'] as const;
export type MailFactCarrier = (typeof MAIL_FACT_CARRIERS)[number];
export const MAIL_FACT_CARRIER_NAMES: Readonly<Record<MailFactCarrier, RegExp>> = {
  UPS: /\b(?:ups|united parcel service)\b/i,
  USPS: /\b(?:usps|u\.?\s?s\.?\s?postal service|united states postal service)\b/i,
  FedEx: /\b(?:fed ?ex|federal express)\b/i,
  DHL: /\bdhl\b/i,
};

/** A carrier's name as a pass reads it, canonical where it names exactly one
 *  of the four, anywhere as a whole word (`Federal Express` → `FedEx`, `UPS
 *  Ground` → `UPS`, `The UPS Store #1234` → `UPS`, `Deutsche Post DHL` →
 *  `DHL`): the carrier is what joins a parcel's emails, with its tracking
 *  number. A name that names none of them, or two (`FedEx via UPS`), is kept
 *  as a fact stores text (`mailFactStoredText`). */
export const canonicalMailFactCarrier = (name: string): string => {
  const stored = mailFactStoredText(name);
  const named = MAIL_FACT_CARRIERS.filter((carrier) => MAIL_FACT_CARRIER_NAMES[carrier].test(stored));
  return named.length === 1 ? named[0]! : stored;
};

/** When the newest email about a thing arrived, on every thing of every kind
 *  (ruling 44): the email's date as its mailbox stores it — the `Date:` header
 *  on Gmail and IMAP, the received time on Outlook — never later than when it
 *  was read (ms). A newer email always changes it, even when it changes nothing
 *  else, so a trigger that names it in `fields` wakes for every new email about
 *  the thing; one that does not — "every change" included — never wakes for a
 *  change of this alone. It is the thing's, not a fact's: no template reads it,
 *  and `where` cannot match it. */
export const MAIL_FACT_LAST_EMAIL_AT = 'last_email_at';

/** Names a declared variable may not take: the implicit variables, and the
 *  fields the event record carries beside the variables (§5), which a `where`
 *  key would otherwise collide with. */
export const MAIL_FACT_RESERVED_VARIABLE_NAMES: ReadonlySet<string> = new Set([
  MAIL_FACT_STATE_VARIABLE,
  MAIL_FACT_NOTICE_VARIABLE,
  MAIL_FACT_LAST_EMAIL_AT,
  '_id',
  '_collection',
  'thing_id',
  'type',
  'complete',
  'missing',
  'template',
  'fact',
  'passes',
  'identity_keys',
]);

/** Every variable of a type: its declared ones, then `state` (an enum of its
 *  states) and, when it has notices, `notice`. */
export const mailFactTypeVariables = (spec: MailFactTypeSpec): readonly MailFactVariableSpec[] => {
  const out: MailFactVariableSpec[] = [...spec.variables];
  if (spec.states.length > 0) {
    out.push({ name: MAIL_FACT_STATE_VARIABLE, kind: 'enum', required: false, values: spec.states });
  }
  if (spec.notices.length > 0) {
    out.push({ name: MAIL_FACT_NOTICE_VARIABLE, kind: 'enum', required: false, values: spec.notices });
  }
  return out;
};

/** The default entrance (§3.1): a type's required variables. A template can
 *  change it, down to its conditions alone (ruling 39). */
export const mailFactDefaultEntrance = (spec: MailFactTypeSpec): readonly string[] =>
  spec.variables.filter((variable) => variable.required).map((variable) => variable.name);

// ────────────────────────────────────────────────────────────────
// Templates (§4)
// ────────────────────────────────────────────────────────────────

/** The fields an entrance condition can test (§4.1). */
export const MAIL_TEMPLATE_CONDITION_FIELDS = [
  'from',
  'subject',
  'body',
  'label',
  'relationship',
  'attachment',
] as const;
export type MailTemplateConditionField = (typeof MAIL_TEMPLATE_CONDITION_FIELDS)[number];

export const MAIL_TEMPLATE_CONDITION_OPS = [
  'is',
  'domain_is',
  'contains',
  'matches',
  'type_is',
  'name_matches',
] as const;
export type MailTemplateConditionOp = (typeof MAIL_TEMPLATE_CONDITION_OPS)[number];

/** Which ops each field accepts. */
export const MAIL_TEMPLATE_CONDITION_OPS_BY_FIELD: Readonly<
  Record<MailTemplateConditionField, readonly MailTemplateConditionOp[]>
> = {
  from: ['is', 'domain_is', 'contains', 'matches'],
  subject: ['is', 'contains', 'matches'],
  body: ['contains', 'matches'],
  label: ['is'],
  relationship: ['is'],
  attachment: ['type_is', 'name_matches'],
};

export interface MailTemplateCondition {
  readonly field: MailTemplateConditionField;
  readonly op: MailTemplateConditionOp;
  readonly value: string;
  /** Exclude instead of require (*"subject does not contain 'sign-in'"*). */
  readonly negate?: boolean;
}

export interface MailTemplateEntrance {
  /** All must hold. */
  readonly conditions: readonly MailTemplateCondition[];
  /** The variables that must be read, by rules, for a fact to exist. */
  readonly variables: readonly string[];
}

/** Where a value is read from (§4.2). */
export const MAIL_TEMPLATE_SOURCES = [
  'subject',
  'body',
  'html',
  'from_address',
  'from_name',
  'header',
  'attachment',
] as const;
export type MailTemplateSource = (typeof MAIL_TEMPLATE_SOURCES)[number];

/** How a value is found in its source (§4.2). */
export type MailTemplateFinder =
  /** The text after a label, to the end of its line. */
  | { readonly kind: 'after_label'; readonly label: string }
  /** A pattern with exactly one capture group; the group is the value. */
  | { readonly kind: 'pattern'; readonly pattern: string; readonly flags?: string }
  /** The source as a whole. */
  | { readonly kind: 'whole' }
  /** A constant the template sets, e.g. a fixed state. Not read from the email:
   *  it does not satisfy an entrance variable. */
  | { readonly kind: 'constant'; readonly value: string }
  /** The first case whose words the source contains, e.g. subject words to a
   *  state. */
  | {
      readonly kind: 'keyword_map';
      readonly cases: readonly { readonly contains: string; readonly value: string }[];
    }
  /** An attachment picked by name or type; the value is its file record id. */
  | { readonly kind: 'attachment'; readonly by: 'name' | 'type'; readonly match: string };

export type MailTemplateTarget =
  | { readonly variable: string }
  /** A dot path into the fact's data. */
  | { readonly data: string };

export interface MailTemplateRule {
  readonly target: MailTemplateTarget;
  readonly source: MailTemplateSource;
  /** The header name, when `source` is `header`. */
  readonly header?: string;
  readonly find: MailTemplateFinder;
  /** For a data target: the kind to normalize to. A variable uses its own kind. */
  readonly normalize?: MailFactVariableKind;
  /** A BCP 47 tag for reading `money` and `date` values (`de-DE`, `en-US`). */
  readonly locale?: string;
}

/** A repeated block (§4.2): the source is split at each match of `split`, and
 *  each block yields its own fact. Rules on other sources apply to every block. */
export interface MailTemplateRepeat {
  readonly source: 'body' | 'html';
  readonly split: string;
}

export const MAIL_FACT_POOL_POLICIES = ['free_only', 'free_then_byok', 'byok_only'] as const;
export type MailFactPoolPolicy = (typeof MAIL_FACT_POOL_POLICIES)[number];

export type MailTemplateAi =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly prompt: string;
      /** Data paths, and variables outside the entrance (rulings 37, 39). */
      readonly slots: readonly string[];
      readonly pool: MailFactPoolPolicy;
    };

/** The value at a dot path of a fact's data; `undefined` when absent. Only
 *  the data's own keys count: never what an object inherits. */
export const mailFactDataAt = (data: unknown, path: string): unknown => {
  let cursor: unknown = data;
  for (const segment of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(cursor, segment)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
};

/** The slots of an AI-on template that no pass read in a fact (§4.3): what the
 *  AI may still fill. The AI is skipped when there are none. */
export const mailFactEmptyAiSlots = (
  slots: readonly string[],
  fact: { readonly variables: Readonly<Record<string, unknown>>; readonly data: unknown },
): string[] =>
  slots.filter((slot) => {
    if (slot.startsWith('data.')) return !mailFactDataPlaceTaken(fact.data, slot.slice('data.'.length));
    const value = fact.variables[slot];
    return value === undefined || value === null;
  });

/** Whether a data path's place is taken: a value at the path, or a value on
 *  the way to it that is not an object — `data.order` holding a string another
 *  pass read takes `data.order.id` too, since writing there would replace it. */
export const mailFactDataPlaceTaken = (data: unknown, path: string): boolean => {
  let cursor: unknown = data;
  for (const segment of path.split('.')) {
    if (cursor === null || cursor === undefined) return false;
    if (typeof cursor !== 'object' || Array.isArray(cursor)) return true;
    if (!Object.prototype.hasOwnProperty.call(cursor, segment)) return false;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor !== null && cursor !== undefined;
};

export type MailTemplateOrigin =
  | { readonly kind: 'owner' }
  | {
      readonly kind: 'recipe';
      readonly publisher: string;
      readonly recipe: string;
      readonly variable: string;
      readonly version: number;
      readonly pack?: string;
    };

/** What a template is made of, without its server-side bookkeeping. The shape a
 *  recipe's `starter` carries (§5.2) and an rpc create accepts. */
export interface MailTemplateDefinition {
  readonly name: string;
  readonly type: MailFactTypeId;
  readonly entrance: MailTemplateEntrance;
  readonly rules: readonly MailTemplateRule[];
  readonly repeat?: MailTemplateRepeat;
  readonly html: boolean;
  readonly ai: MailTemplateAi;
}

/** A template's health (§6.2): how often its conditions held (`matched`),
 *  how often a fact then met the entrance (`entered`), and how often it did not
 *  (`not_entered` — the sign a sender changed its email). */
export interface MailTemplateHealth {
  readonly matched: number;
  readonly entered: number;
  readonly not_entered: number;
  readonly last_matched_at?: number;
  readonly last_entered_at?: number;
  readonly last_not_entered_at?: number;
  /** The latest warning, e.g. a pattern stopped for running too long. */
  readonly last_warning?: string;
  readonly last_warning_at?: number;
}

export interface MailTemplate extends MailTemplateDefinition {
  readonly template_id: string;
  readonly origin: MailTemplateOrigin;
  /** One template is active per type and set of conditions (ruling 31). */
  readonly active: boolean;
  readonly revision: number;
  readonly health: MailTemplateHealth;
  readonly created_at: number;
  readonly updated_at: number;
}

// ────────────────────────────────────────────────────────────────
// Facts and things (§5)
// ────────────────────────────────────────────────────────────────

/** Which pass filled a value. */
export const MAIL_FACT_PASSES = ['standard', 'rule', 'ai'] as const;
export type MailFactPass = (typeof MAIL_FACT_PASSES)[number];

export interface MailFactEmailRef {
  readonly slug: string;
  readonly record_id: string;
}

export interface MailFactRefusal {
  readonly variable: string;
  readonly reason: string;
}

/** The AI pass on one fact (§4.3). Absent when its template's AI is off, or
 *  when every slot the AI may fill was already read. */
export type MailFactAi =
  /** Queued. Until it answers, the fact joins no thing and starts nothing. */
  | { readonly state: 'waiting'; readonly since: number }
  /** It answered. `filled` names the slots it filled — none is an answer too. */
  | { readonly state: 'read'; readonly filled: readonly string[]; readonly at: number }
  /** It could not answer: paused, no model, out of quota, timed out, or the
   *  privacy layer could not protect the email. Its slots stay empty and the
   *  fact goes on with what the rules read. */
  | { readonly state: 'not_read'; readonly reason: string; readonly at: number };

/** §6.1 — how long the server waits for the model on Draft with AI: one
 *  owner-started call drafts a whole template. The screen waits longer than
 *  this (`MAIL_TEMPLATE_DRAFT_RPC_TIMEOUT_MS`), so the answer the owner pays for
 *  is never dropped by a screen that gave up first. */
export const MAIL_TEMPLATE_DRAFT_TIMEOUT_MS = 90_000;
/** §6.1 — the screen's wait: the model's, with room to read the email and
 *  alias it first. */
export const MAIL_TEMPLATE_DRAFT_RPC_TIMEOUT_MS = MAIL_TEMPLATE_DRAFT_TIMEOUT_MS + 30_000;

/** §9 — the entity the AI pass marks a fact's reading with, so the privacy
 *  layer aliases the people in it (`CANONICAL_PII_ENTITY_PRIVACY_TAGS`). */
export const MAIL_FACT_PII_ENTITY = 'mail_fact';

/** §9 — the variables that name a person, by what they hold: a lead's name,
 *  email and phone, a buyer's name and email. A template read them, so they are
 *  known — not guessed from free text — and go to the AI aliased, and so do
 *  their copies in the email itself. By name, as a trigger reads them: an
 *  owner's kind with a variable called `email` holds an email. */
export const MAIL_FACT_PERSON_VARIABLES: Readonly<Record<string, 'name' | 'email' | 'phone'>> = {
  name: 'name',
  email: 'email',
  phone: 'phone',
  buyer_name: 'name',
  buyer_email: 'email',
};

export interface MailFact {
  readonly fact_id: string;
  readonly type: MailFactTypeId;
  /** `null` for a fact only the standards pass read. */
  readonly template_id: string | null;
  readonly email: MailFactEmailRef;
  /** The email's own date (not when it arrived), which orders a thing's state. */
  readonly email_at: number;
  /** Its place among one template's facts from one email (a repeated block). */
  readonly position: number;
  readonly identity_keys: readonly string[];
  /** The thing it folds into. `null` for an UNPAIRED standards fact (§4): it
   *  could be the same thing as a template's fact that read no identity, so it
   *  is kept and shown, joins no thing and triggers nothing. `null` too while
   *  the fact waits for the AI (`ai.state === 'waiting'`): an identity the AI
   *  fills decides which thing it joins (ruling 39). */
  readonly thing_id: string | null;
  /** Every variable of the type, `null` when unread. */
  readonly variables: Readonly<Record<string, MailFactValue | null>>;
  /** Variable name, or `data.<path>`, to the pass that filled it. */
  readonly passes: Readonly<Record<string, MailFactPass>>;
  readonly data: unknown;
  /** Required variables left unread. */
  readonly missing: readonly string[];
  /** Values a pass read and the core refused, with why. */
  readonly refused: readonly MailFactRefusal[];
  readonly complete: boolean;
  /** The email content and template revision the fact was read from. */
  readonly source_hash: string;
  readonly revision: number;
  readonly created_at: number;
  /** The AI pass, when its template has the AI on and a slot was empty (§4.3). */
  readonly ai?: MailFactAi;
}

export interface MailFactThing {
  readonly thing_id: string;
  readonly type: MailFactTypeId;
  readonly identity_keys: readonly string[];
  readonly variables: Readonly<Record<string, MailFactValue | null>>;
  readonly passes: Readonly<Record<string, MailFactPass>>;
  /** Per variable: the date of the email whose fact set it (newest wins). */
  readonly variable_email_at: Readonly<Record<string, number>>;
  /** When the newest of its emails arrived (`MAIL_FACT_LAST_EMAIL_AT`). */
  readonly last_email_at: number;
  readonly missing: readonly string[];
  readonly complete: boolean;
  readonly created_at: number;
  readonly updated_at: number;
}

// ────────────────────────────────────────────────────────────────
// The standards pass (§7.1): the types a template-free recognizer reads
// ────────────────────────────────────────────────────────────────

/** Read with no template — schema.org markup, tracking numbers, owner
 *  requests — on by default, and switchable per type (ruling 10). */
export const MAIL_FACT_STANDARDS_TYPES = [
  'shipment',
  'purchase',
  'bill',
  'reservation',
  'owner_request',
] as const satisfies readonly MailFactBuiltinTypeId[];
export type MailFactStandardsType = (typeof MAIL_FACT_STANDARDS_TYPES)[number];

export const isMailFactStandardsType = (value: unknown): value is MailFactStandardsType =>
  typeof value === 'string' && (MAIL_FACT_STANDARDS_TYPES as readonly string[]).includes(value);

export interface MailFactStandardsSetting {
  readonly type: MailFactStandardsType;
  readonly on: boolean;
}

// ────────────────────────────────────────────────────────────────
// The owner's template rpc (`mail_fact.template.*`), reserved out of MCP
// ────────────────────────────────────────────────────────────────

export interface MailTemplateCreateRequest {
  readonly definition: MailTemplateDefinition;
  /** Default true. */
  readonly active?: boolean;
}

export interface MailTemplateUpdateRequest {
  readonly template_id: string;
  /** A new definition is a new revision: new mail is read with it, and past
   *  mail only by a backfill (§6.3). */
  readonly definition?: MailTemplateDefinition;
  readonly active?: boolean;
}

// ────────────────────────────────────────────────────────────────
// Reads (§5): `core.mail.fact.get` / `core.mail.fact.list`
// ────────────────────────────────────────────────────────────────

/** `core.mail.fact.get`: a thing with its facts, or one fact with its thing. */
export interface MailFactGetResult {
  readonly thing: MailFactThing | null;
  readonly facts: readonly MailFact[];
}

export const MAIL_FACT_LIST_OF = ['things', 'facts'] as const;
export type MailFactListOf = (typeof MAIL_FACT_LIST_OF)[number];

export const MAIL_FACT_LIST_DEFAULT_LIMIT = 100;
export const MAIL_FACT_LIST_MAX_LIMIT = 500;

/** `core.mail.fact.list`, as the kernel hands it to the server. */
export interface MailFactListInput {
  /** Things (default), or the facts they fold. */
  readonly of: MailFactListOf;
  readonly type?: MailFactTypeId;
  /** Things in this state. Things only. */
  readonly state?: string;
  /** The thing these identity values name (`{ carrier, tracking_number }`).
   *  Needs `type`. Things only. */
  readonly identity?: Readonly<Record<string, string>>;
  /** Things updated, or facts whose email is dated, on or after this time. */
  readonly since?: number;
  readonly limit?: number;
}

// ────────────────────────────────────────────────────────────────
// The owner's screens (§6): the facts list and an email's facts
// ────────────────────────────────────────────────────────────────

/** How a fire a fact's event started ended when it was made (§6.4) — the
 *  dispatcher's `trigger_fired` outcomes. */
export const MAIL_FACT_RUN_OUTCOMES = ['completed', 'held', 'declined', 'total_refusal', 'failed'] as const;
export type MailFactRunOutcome = (typeof MAIL_FACT_RUN_OUTCOMES)[number];

export const isMailFactRunOutcome = (value: unknown): value is MailFactRunOutcome =>
  typeof value === 'string' && (MAIL_FACT_RUN_OUTCOMES as readonly string[]).includes(value);

/** A recipe run one email's facts started through a thing's event, whatever
 *  became of it. */
export interface MailFactRun {
  readonly trigger_id: string;
  readonly recipe_id: string;
  /** The recipe's name, while it is installed. */
  readonly recipe_name?: string;
  /** Absent when the fire failed before a run existed. */
  readonly run_id?: string;
  readonly outcome: MailFactRunOutcome;
  /** The run's status now, while the run log holds it: a run held for
   *  approval that the owner approved reads `succeeded` here. */
  readonly status?: RunAnchorStatus;
  readonly at: number;
}

/** The email a fact came from, as the list shows it. */
export interface MailFactEmailSummary {
  readonly slug: string;
  readonly record_id: string;
  readonly from: string;
  readonly subject: string;
  /** The email's own date. */
  readonly at: number;
  /** When the email, and its facts with it, may go (§5.3): its date plus the
   *  days its mailbox keeps mail. Absent when the mailbox is gone. */
  readonly goes_at?: number;
}

/** One row of the facts list: one fact (§6.4). */
export interface MailFactRow {
  readonly fact: MailFact;
  /** `null` when the email is no longer stored, or its mailbox was removed. */
  readonly email: MailFactEmailSummary | null;
  /** The email's mailbox was removed from this server. Removing a mailbox
   *  keeps the mail it stored, so the email's facts stay with it (ruling 11)
   *  and show again when the mailbox is added back. */
  readonly mailbox_removed?: true;
  /** The thing the fact joined; `null` for an unpaired fact. */
  readonly thing: MailFactThing | null;
  /** "1 of 3 from this email": its place among all its email's facts. */
  readonly of_email: { readonly index: number; readonly count: number };
  readonly runs: readonly MailFactRun[];
}

/** Keyset position: the last email of the page before. */
export interface MailFactRowsCursor {
  readonly email_at: number;
  readonly slug: string;
  readonly record_id: string;
}

export const MAIL_FACT_ROWS_DEFAULT_EMAILS = 50;
export const MAIL_FACT_ROWS_MAX_EMAILS = 200;

/** `mail_fact.facts.list`. A page is a number of EMAILS, newest first, each
 *  with every fact of it that meets the filters, so one email's rows stay
 *  together. */
export interface MailFactRowsQuery {
  readonly type?: string;
  /** The thing's state, or an unpaired fact's own. */
  readonly state?: string;
  /** The fact's notice. */
  readonly notice?: string;
  /** Read by this template; `null` for facts the standards pass read alone. */
  readonly template_id?: string | null;
  readonly complete?: boolean;
  readonly unpaired?: boolean;
  readonly has_run?: boolean;
  /** One email's facts ("Facts from this email"). */
  readonly email?: MailFactEmailRef;
  readonly before?: MailFactRowsCursor;
  /** Emails per page. */
  readonly limit?: number;
}

export interface MailFactRowsPage {
  readonly rows: readonly MailFactRow[];
  readonly next_cursor?: MailFactRowsCursor;
}

/** `mail_fact.email.get` — what the mail detail view needs for its two
 *  actions (§6): whether the email gave facts, and whether it is a security
 *  notice, on which neither action is offered (§9). */
export interface MailFactEmailStatus {
  readonly fact_count: number;
  readonly security_notice: boolean;
}

// ── The template editor (§6.1, §6.2) ────────────────────────────

/** How an email was read for the editor: again from its provider, whole; from
 *  the stored copy, which has no HTML, headers, sender name or attachments; or
 *  as the owner pasted it. */
export const MAIL_TEMPLATE_READS = ['provider', 'stored', 'sample'] as const;
export type MailTemplateRead = (typeof MAIL_TEMPLATE_READS)[number];

/** A pasted email, for an author with no such email (§5.2, §6.1). */
export interface MailTemplateSample {
  /** The sender: an address, or `Name <address>`. */
  readonly from: string;
  readonly subject: string;
  readonly body: string;
  readonly html?: string;
}

/** `mail_fact.email.read` — an email as the editor shows it, its values to
 *  click. Refused on a security notice (§9). */
export interface MailFactEmailContent {
  readonly email: MailFactEmailSummary;
  readonly from_name: string;
  readonly body_text: string;
  /** Only when read again from its provider. */
  readonly html?: string;
  readonly labels: readonly string[];
  readonly attachments: readonly { readonly filename: string; readonly mime_type: string }[];
  readonly read: Exclude<MailTemplateRead, 'sample'>;
  /** The text or HTML was cut to `MAIL_FACT_EMAIL_CONTENT_MAX_CHARS` for the
   *  editor; the rules still read the whole email. */
  readonly truncated?: true;
}

export const MAIL_FACT_EMAIL_CONTENT_MAX_CHARS = 200_000;
/** A pasted sample's parts, at most. */
export const MAIL_TEMPLATE_SAMPLE_MAX_CHARS = { subject: 2_000, body: 200_000, html: 1_000_000 } as const;

/** `mail_fact.template.draft` (§6.1, ruling 21): Draft with AI — one call,
 *  started by the owner, on the one email they chose, through the chat's
 *  privacy layer; refused on a security notice (§9). What it proposes is rules,
 *  which run with no AI: the owner checks the draft with Preview. */
export interface MailTemplateDraftRequest {
  readonly source: { readonly email: MailFactEmailRef } | { readonly sample: MailTemplateSample };
  /** The kind of email the owner picked; the AI proposes one when absent. */
  readonly type?: string;
}

export interface MailTemplateDraftResult {
  /** A whole template, AI off, ready for Preview. */
  readonly definition: MailTemplateDefinition;
  /** What the AI proposed that could not be used, and why. */
  readonly dropped: readonly string[];
}

export const MAIL_TEMPLATE_PREVIEW_DEFAULT_LIMIT = 10;
export const MAIL_TEMPLATE_PREVIEW_MAX_LIMIT = 25;

/** `mail_fact.template.preview` (§6.2): a template, not yet saved, run over the
 *  email it is made from and the newest stored emails that meet its
 *  conditions. Nothing is stored and nothing fires. */
export interface MailTemplatePreviewRequest {
  readonly definition: MailTemplateDefinition;
  readonly source?: { readonly email: MailFactEmailRef } | { readonly sample: MailTemplateSample };
  /** How many recent emails to read besides the source. */
  readonly limit?: number;
}

export type MailTemplatePreviewOutcome = 'no_match' | 'not_entered' | 'entered';

export interface MailTemplatePreviewFact {
  readonly position: number;
  readonly variables: Readonly<Record<string, MailFactValue | null>>;
  readonly passes: Readonly<Record<string, MailFactPass>>;
  readonly data: unknown;
  readonly missing: readonly string[];
  readonly refused: readonly MailFactRefusal[];
  readonly complete: boolean;
}

export interface MailTemplatePreviewEmail {
  /** Absent for a pasted sample. */
  readonly email?: MailFactEmailSummary;
  readonly read: MailTemplateRead;
  readonly outcome: MailTemplatePreviewOutcome;
  /** The entrance variables its rules did not read, when it did not enter. */
  readonly unread?: readonly string[];
  readonly facts: readonly MailTemplatePreviewFact[];
  readonly warnings?: readonly string[];
}

export interface MailTemplatePreviewResult {
  readonly source?: MailTemplatePreviewEmail;
  /** Newest first. */
  readonly recent: readonly MailTemplatePreviewEmail[];
  /** How many stored emails were looked at to find them. */
  readonly scanned: number;
}

// ── Senders without a template (§6.5) ───────────────────────────

/** The window the senders are counted over. */
export const MAIL_FACT_SENDERS_DAYS = 30;
export const MAIL_FACT_SENDERS_DEFAULT_LIMIT = 20;
export const MAIL_FACT_SENDERS_MAX_LIMIT = 100;

/** A sender the owner gets mail from that no template and no standard reads. */
export interface MailFactSender {
  /** Lower case. */
  readonly address: string;
  /** Its emails in the window. */
  readonly count: number;
  /** Its most common subjects, most common first; numbers in a subject are
   *  ignored when counting, and the newest wording is shown. */
  readonly subjects: readonly { readonly subject: string; readonly count: number }[];
  /** Its newest email: "Make a template" opens the editor on it. */
  readonly newest: MailFactEmailSummary;
}

/** `mail_fact.senders.list` — counted from the mail already stored, with no
 *  AI. Outbound mail, drafts, mail Recued sent and security notices are left
 *  out, and so is a sender the owner dismissed. */
export interface MailFactSendersResult {
  readonly senders: readonly MailFactSender[];
  /** The senders the owner dismissed, to show again on request. */
  readonly dismissed: readonly string[];
  readonly days: number;
  /** How many emails were counted. */
  readonly scanned: number;
}

export interface MailFactSenderDismissal {
  readonly address: string;
  /** `false` shows the sender again. */
  readonly dismissed: boolean;
}

// ── Backfill: mail that already arrived (§6.3) ──────────────────

/** `mail_fact.backfill.start`: read a template's past mail, one job at a time. */
export interface MailFactBackfillRequest {
  readonly template_id: string;
  /** Mail dated in the last `days` days, as far back as mail is still stored. */
  readonly days: number;
  /** Also run the recipes these facts trigger, stamped as backfill runs.
   *  Default false: past mail stores facts and fires nothing. */
  readonly run_recipes?: boolean;
}

export const MAIL_FACT_BACKFILL_STATUSES = ['running', 'done', 'failed', 'cancelled'] as const;
export type MailFactBackfillStatus = (typeof MAIL_FACT_BACKFILL_STATUSES)[number];

export interface MailFactBackfillJob {
  readonly job_id: string;
  readonly template_id: string;
  readonly days: number;
  readonly run_recipes: boolean;
  readonly status: MailFactBackfillStatus;
  /** The stored emails in the period that may meet the template's conditions. */
  readonly total: number;
  /** Of those, how many were read so far. */
  readonly read: number;
  /** Facts written by this backfill. */
  readonly facts: number;
  /** Thing events it emitted (only when it runs recipes). */
  readonly events: number;
  /** Emails its provider could not give whole again, read from the stored
   *  copy instead. */
  readonly stored_copies: number;
  /** Of those, emails that already had facts from the whole email: kept as
   *  they were rather than replaced by a poorer reading. */
  readonly kept: number;
  readonly error?: string;
  readonly started_at: number;
  readonly finished_at?: number;
}

/** `mail_fact.backfill.get`: the running or last job, and how far back mail
 *  is kept — the period a backfill can reach. */
export interface MailFactBackfillState {
  readonly job: MailFactBackfillJob | null;
  /** The longest any mailbox keeps mail, in days. */
  readonly max_days: number;
}

// ────────────────────────────────────────────────────────────────
// Events (§5, §5.1)
// ────────────────────────────────────────────────────────────────

export const MAIL_FACT_EVENT_PLATFORM = 'mail_fact' as const;
export const MAIL_FACT_EVENT_ENTITY_TYPE = 'thing' as const;
export const MAIL_FACT_EVENT_KINDS = ['created', 'updated'] as const;
export type MailFactEventKind = (typeof MAIL_FACT_EVENT_KINDS)[number];

/** `data.mail_fact.<type>.thing.<kind>` — the type is the path's slug segment. */
export const mailFactEventPath = (type: MailFactTypeId, kind: MailFactEventKind): string =>
  `data.${MAIL_FACT_EVENT_PLATFORM}.${type}.${MAIL_FACT_EVENT_ENTITY_TYPE}.${kind}`;

/** The trigger shorthand (§5.1): `{ "on": "mail_fact" }` for a thing of any
 *  kind — the variables it designates, whatever kind of email has them (ruling
 *  42) — or `{ "on": "mail_fact.<type>" }` for one kind, which a recipe usually
 *  is about (ruling 43). */
export const MAIL_FACT_ON_SHORTHAND = MAIL_FACT_EVENT_PLATFORM;
export const MAIL_FACT_ON_PREFIX = `${MAIL_FACT_ON_SHORTHAND}.`;

/** The `on` of a trigger on one kind, or on any kind. */
export const mailFactOn = (type: string | null): string =>
  type === null ? MAIL_FACT_ON_SHORTHAND : `${MAIL_FACT_ON_PREFIX}${type}`;

/** What a fact subscription compiles to: one kind's things, or every kind's. */
export const mailFactEventPattern = (type: string | null): string =>
  `data.${MAIL_FACT_EVENT_PLATFORM}.${type ?? '*'}.${MAIL_FACT_EVENT_ENTITY_TYPE}.*`;
export const MAIL_FACT_EVENT_PATTERN = mailFactEventPattern(null);

/** The fact that caused a thing's change, carried in its event. */
export interface MailFactEventFact {
  readonly fact_id: string;
  readonly email: MailFactEmailRef;
  readonly email_at: number;
  readonly template_id: string | null;
  readonly data: unknown;
  readonly passes: Readonly<Record<string, MailFactPass>>;
}

/** The event's `record`: the thing after the change, its variables at the TOP
 *  level so a `where` key reads `record.<variable>`, then the fields around
 *  them. Every variable of its kind is present, `null` when unread; a variable
 *  its kind does not have is absent, and the dispatch filter reads an absent
 *  path on a fact as no match. That is what makes a fact trigger's `where`
 *  strict across kinds (§5.1). */
export interface MailFactTriggerRecord {
  /** Each variable of the type, by name: `MailFactValue | null`. */
  readonly [variable: string]: unknown;
  readonly _id: string;
  readonly _collection: typeof MAIL_FACT_EVENT_PLATFORM;
  readonly thing_id: string;
  readonly type: MailFactTypeId;
  readonly identity_keys: readonly string[];
  readonly complete: boolean;
  readonly missing: readonly string[];
  /** When the newest email about the thing arrived (ruling 44). */
  readonly last_email_at: number;
  /** The template of the fact that caused the change; `null` for a standards fact. */
  readonly template: string | null;
  readonly passes: Readonly<Record<string, MailFactPass>>;
  readonly fact: MailFactEventFact;
}

/** The keys a fact trigger's `where` may use besides the type's filterable
 *  variables. Anything else is refused at validation: data is not filterable
 *  (ruling 24). */
export const MAIL_FACT_WHERE_EXTRA_KEYS: ReadonlySet<string> = new Set(['complete', 'template']);

/** The keys a `where` on this type may use. */
export const mailFactWhereKeys = (spec: MailFactTypeSpec): ReadonlySet<string> => {
  const keys = new Set<string>(MAIL_FACT_WHERE_EXTRA_KEYS);
  for (const variable of mailFactTypeVariables(spec)) {
    if (MAIL_FACT_FILTERABLE_KINDS.has(variable.kind)) keys.add(variable.name);
  }
  return keys;
};

/** The keys `fields` may name on this type: every variable, and when its
 *  newest email arrived (every new email about the thing). */
export const mailFactFieldKeys = (spec: MailFactTypeSpec): ReadonlySet<string> =>
  new Set([...mailFactTypeVariables(spec).map((variable) => variable.name), MAIL_FACT_LAST_EMAIL_AT]);

// ────────────────────────────────────────────────────────────────
// Structural validation of a template (§4, §4.1, §4.3)
// ────────────────────────────────────────────────────────────────

/** Bounds on what a template may carry. A template's patterns run on the
 *  server over every email its conditions match. */
export const MAIL_TEMPLATE_LIMITS = {
  maxName: 120,
  maxConditions: 20,
  maxRules: 60,
  maxPatternLength: 500,
  maxValueLength: 500,
  maxKeywordCases: 30,
  maxPromptLength: 4000,
  /** Repeated blocks read from one email: one fact each, and each fact can
   *  start every subscribed recipe. */
  maxBlocks: 100,
  /** A whole definition, as JSON: every email is read with it. */
  maxBytes: 64 * 1024,
} as const;

const plainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const optionalString = (value: unknown): boolean => value === undefined || typeof value === 'string';

/** What is wrong with a definition's SHAPE, before anything is checked in it:
 *  a definition is data from a client or a recipe, and a wrong shape must be a
 *  listed problem, never a thrown TypeError. */
export const mailTemplateShapeProblems = (raw: unknown): string[] => {
  if (!plainObject(raw)) return ['a template must be an object'];
  const problems: string[] = [];
  let size = Infinity;
  try {
    size = new TextEncoder().encode(JSON.stringify(raw)).length;
  } catch {
    // circular or not JSON: refused below by size
  }
  if (size > MAIL_TEMPLATE_LIMITS.maxBytes) problems.push(`the template is larger than ${MAIL_TEMPLATE_LIMITS.maxBytes / 1024} KB`);
  if (typeof raw.name !== 'string') problems.push('name must be text');
  if (typeof raw.type !== 'string') problems.push('type must be a kind of email');
  if (!plainObject(raw.entrance)) problems.push('entrance must be an object with conditions and variables');
  else {
    const { conditions, variables } = raw.entrance;
    if (!Array.isArray(conditions)) problems.push('entrance.conditions must be a list');
    else {
      conditions.forEach((condition, i) => {
        if (!plainObject(condition) || typeof condition.field !== 'string' || typeof condition.op !== 'string'
          || typeof condition.value !== 'string' || !(condition.negate === undefined || typeof condition.negate === 'boolean')) {
          problems.push(`entrance.conditions[${i}] must have a field, an op and a value, all text (and negate, true or false)`);
        }
      });
    }
    if (!Array.isArray(variables) || variables.some((name) => typeof name !== 'string')) {
      problems.push('entrance.variables must be a list of variable names');
    }
  }
  if (!Array.isArray(raw.rules)) problems.push('rules must be a list');
  else {
    raw.rules.forEach((rule, i) => {
      const at = `rules[${i}]`;
      if (!plainObject(rule)) {
        problems.push(`${at} must be an object`);
        return;
      }
      const target = rule.target;
      if (!plainObject(target) || (typeof target.variable === 'string') === (typeof target.data === 'string')) {
        problems.push(`${at}.target must name one variable or one data path`);
      }
      if (typeof rule.source !== 'string' || !optionalString(rule.header) || !optionalString(rule.normalize) || !optionalString(rule.locale)) {
        problems.push(`${at} must have a source (and header, normalize and locale, when given, as text)`);
      }
      const find = rule.find;
      if (!plainObject(find) || typeof find.kind !== 'string') {
        problems.push(`${at}.find must be an object with a kind`);
        return;
      }
      const ok = find.kind === 'after_label' ? typeof find.label === 'string'
        : find.kind === 'pattern' ? typeof find.pattern === 'string' && optionalString(find.flags)
          : find.kind === 'whole' ? true
            : find.kind === 'constant' ? typeof find.value === 'string'
              : find.kind === 'keyword_map' ? Array.isArray(find.cases) && find.cases.every((c) =>
                plainObject(c) && typeof c.contains === 'string' && typeof c.value === 'string')
                : find.kind === 'attachment' ? (find.by === 'name' || find.by === 'type') && typeof find.match === 'string'
                  : false;
      if (!ok) problems.push(`${at}.find is not a finder Recued knows, in the shape it takes`);
    });
  }
  if (raw.repeat !== undefined && !(plainObject(raw.repeat) && typeof raw.repeat.source === 'string' && typeof raw.repeat.split === 'string')) {
    problems.push('repeat must have a source and a split, both text');
  }
  if (typeof raw.html !== 'boolean') problems.push('html must be true or false');
  const ai = raw.ai;
  if (!plainObject(ai) || typeof ai.enabled !== 'boolean') problems.push('ai must say whether it is on');
  else if (ai.enabled && (typeof ai.prompt !== 'string' || typeof ai.pool !== 'string'
    || !Array.isArray(ai.slots) || ai.slots.some((slot) => typeof slot !== 'string'))) {
    problems.push('an AI that is on needs a prompt, a pool and a list of slots');
  }
  return problems;
};

/** A definition rebuilt from the keys a template has — nothing else a client
 *  sent is stored, at any depth. Its shape must have passed. */
export const mailTemplateDefinitionOf = (raw: MailTemplateDefinition): MailTemplateDefinition => ({
  name: raw.name,
  type: raw.type,
  entrance: {
    conditions: raw.entrance.conditions.map((condition) => ({
      field: condition.field,
      op: condition.op,
      value: condition.value,
      ...(condition.negate === true ? { negate: true } : {}),
    })),
    variables: [...raw.entrance.variables],
  },
  rules: raw.rules.map((rule): MailTemplateRule => {
    const find = rule.find;
    return {
      target: 'variable' in rule.target ? { variable: rule.target.variable } : { data: rule.target.data },
      source: rule.source,
      ...(rule.header !== undefined ? { header: rule.header } : {}),
      find: find.kind === 'after_label' ? { kind: find.kind, label: find.label }
        : find.kind === 'pattern' ? { kind: find.kind, pattern: find.pattern, ...(find.flags !== undefined ? { flags: find.flags } : {}) }
          : find.kind === 'whole' ? { kind: find.kind }
            : find.kind === 'constant' ? { kind: find.kind, value: find.value }
              : find.kind === 'keyword_map' ? { kind: find.kind, cases: find.cases.map((c) => ({ contains: c.contains, value: c.value })) }
                : { kind: find.kind, by: find.by, match: find.match },
      ...(rule.normalize !== undefined ? { normalize: rule.normalize } : {}),
      ...(rule.locale !== undefined ? { locale: rule.locale } : {}),
    };
  }),
  ...(raw.repeat !== undefined ? { repeat: { source: raw.repeat.source, split: raw.repeat.split } } : {}),
  html: raw.html,
  ai: raw.ai.enabled
    ? { enabled: true, prompt: raw.ai.prompt, slots: [...raw.ai.slots], pool: raw.ai.pool }
    : { enabled: false },
});

const DATA_PATH_SHAPE_RE = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)*$/;

/** Path parts that walk into an object's prototype rather than its data: a
 *  path through one would write an email's text onto every object in the
 *  server process. */
const PROTOTYPE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor']);

/** A data path a fact may be written to: dot-separated lower-case names, none
 *  of them a prototype key (§3.2). */
export const isMailFactDataPath = (path: string): boolean =>
  DATA_PATH_SHAPE_RE.test(path) && !path.split('.').some((part) => PROTOTYPE_KEYS.has(part));

/** The `DATA_PATH_RE.test` the checks below call. */
const DATA_PATH_RE = { test: isMailFactDataPath };
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,80}$/;
const LOCALE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const REGEX_FLAGS_RE = /^[imsu]*$/;

/** One capture group, compiled. `null` when it compiles and has exactly one
 *  group; otherwise the reason. */
const patternProblem = (pattern: string, flags: string | undefined, needGroup: boolean): string | null => {
  if (pattern.length === 0) return 'is empty';
  if (pattern.length > MAIL_TEMPLATE_LIMITS.maxPatternLength) {
    return `is longer than ${MAIL_TEMPLATE_LIMITS.maxPatternLength} characters`;
  }
  if (flags !== undefined && !REGEX_FLAGS_RE.test(flags)) return `has flags other than i, m, s, u`;
  let compiled: RegExp;
  try {
    // As it runs (`canonicalMailFactPattern`): what compiles here compiles there.
    compiled = new RegExp(canonicalMailFactPattern(pattern), flags);
  } catch (error) {
    return `does not compile (${error instanceof Error ? error.message : String(error)})`;
  }
  if (needGroup) {
    // Count capture groups by matching the empty alternation against ''.
    const groups = new RegExp(`${compiled.source}|`, compiled.flags).exec('')!.length - 1;
    if (groups !== 1) return `must have exactly one capture group (has ${groups})`;
  }
  return null;
};

/** Is there anything to this text as the rules pass reads it? */
const readsAsSomething = (text: string): boolean => mailFactStoredText(text).length > 0;

/** Does this pattern, as it runs, match an empty text — and so every email?
 *  One that does not compile is refused elsewhere; here it narrows nothing. */
const matchesEmpty = (pattern: string, flags?: string): boolean => {
  try {
    return new RegExp(canonicalMailFactPattern(pattern), flags).test('');
  } catch {
    return true;
  }
};

/** §4.1, §9 — is an AI-on template's entrance narrower than the sender's
 *  domain? An address; a subject or content condition not every email meets;
 *  or an entrance variable a NARROWING rule reads — after a label, by a
 *  pattern, by keywords. A variable read whole (the sender's name, the
 *  subject), or set as a constant, is in every email and narrows nothing. */
export const mailTemplateNarrowsPastDomain = (
  definition: { readonly entrance: MailTemplateEntrance; readonly rules: readonly MailTemplateRule[] },
): boolean => {
  // Each value as the rules pass reads it: one that reads as nothing — spaces,
  // or characters that show nothing — is in every email.
  const byCondition = definition.entrance.conditions.some((condition) =>
    condition.negate !== true && (
      (condition.field === 'from' && condition.op === 'is')
      || ((condition.field === 'subject' || condition.field === 'body')
        && (condition.op === 'matches' ? !matchesEmpty(condition.value, 'i') : readsAsSomething(condition.value)))));
  if (byCondition) return true;
  const narrowlyRead = new Set<string>();
  for (const rule of definition.rules) {
    if (!('variable' in rule.target)) continue;
    const { find } = rule;
    if ((find.kind === 'after_label' && readsAsSomething(find.label))
      || (find.kind === 'keyword_map' && find.cases.every((c) => readsAsSomething(c.contains)))
      || (find.kind === 'pattern' && !matchesEmpty(find.pattern, find.flags))) {
      narrowlyRead.add(rule.target.variable);
    }
  }
  return definition.entrance.variables.some((name) => narrowlyRead.has(name));
};

/** Structural problems with a template definition, checked against its type.
 *  Empty means well-formed. Pure: the store and the recipe validator share it. */
export const validateMailTemplateDefinition = (
  definition: MailTemplateDefinition,
  spec: MailFactTypeSpec | undefined,
): string[] => {
  // A wrong shape is a list of problems, never a thrown TypeError.
  const shape = mailTemplateShapeProblems(definition);
  if (shape.length > 0) return shape;
  const problems: string[] = [];
  if (spec === undefined) {
    problems.push(`type '${String(definition.type)}' is not a known fact type`);
    return problems;
  }
  if (typeof definition.name !== 'string' || definition.name.trim().length === 0) {
    problems.push('name is required');
  } else if (definition.name.length > MAIL_TEMPLATE_LIMITS.maxName) {
    problems.push(`name is longer than ${MAIL_TEMPLATE_LIMITS.maxName} characters`);
  }
  const variables = new Map(mailFactTypeVariables(spec).map((variable) => [variable.name, variable]));

  // Entrance.
  const conditions = definition.entrance?.conditions ?? [];
  if (conditions.length > MAIL_TEMPLATE_LIMITS.maxConditions) {
    problems.push(`entrance has more than ${MAIL_TEMPLATE_LIMITS.maxConditions} conditions`);
  }
  conditions.forEach((condition, i) => {
    const at = `entrance.conditions[${i}]`;
    // Own keys only: `__proto__` or `constructor` is no field.
    const ops = Object.prototype.hasOwnProperty.call(MAIL_TEMPLATE_CONDITION_OPS_BY_FIELD, condition.field)
      ? MAIL_TEMPLATE_CONDITION_OPS_BY_FIELD[condition.field]
      : undefined;
    if (ops === undefined) {
      problems.push(`${at}: field '${String(condition.field)}' is not one of ${MAIL_TEMPLATE_CONDITION_FIELDS.join(', ')}`);
      return;
    }
    if (!ops.includes(condition.op)) {
      problems.push(`${at}: '${String(condition.op)}' does not apply to ${condition.field} (use ${ops.join(', ')})`);
    }
    if (typeof condition.value !== 'string' || condition.value.length === 0) {
      problems.push(`${at}: value is required`);
    } else if (condition.op !== 'matches' && condition.op !== 'name_matches' && !readsAsSomething(condition.value)) {
      // Read as the email is, it is nothing, which every email contains.
      problems.push(`${at}: value is required — it holds only spaces or characters that show nothing`);
    } else if (condition.value.length > MAIL_TEMPLATE_LIMITS.maxValueLength) {
      problems.push(`${at}: value is longer than ${MAIL_TEMPLATE_LIMITS.maxValueLength} characters`);
    } else if (condition.op === 'matches' || condition.op === 'name_matches') {
      const problem = patternProblem(condition.value, 'i', false);
      if (problem !== null) problems.push(`${at}: pattern ${problem}`);
    } else if (
      condition.field === 'relationship'
      && !(NETWORK_DOMAINS as readonly string[]).includes(condition.value.toLowerCase())
    ) {
      // A relationship the contact graph never holds would match nothing, silently.
      problems.push(`${at}: relationship is one of ${NETWORK_DOMAINS.join(', ')}`);
    }
  });
  const entranceVariables = definition.entrance?.variables ?? [];
  const ruleTargets = new Set(
    (definition.rules ?? [])
      .filter((rule) => 'variable' in rule.target && rule.find.kind !== 'constant')
      .map((rule) => (rule.target as { variable: string }).variable),
  );
  for (const name of entranceVariables) {
    if (!variables.has(name)) {
      problems.push(`entrance variable '${name}' is not a variable of ${spec.id}`);
    } else if (!ruleTargets.has(name)) {
      problems.push(`entrance variable '${name}' has no rule that reads it from the email`);
    }
  }
  if (conditions.length === 0 && entranceVariables.length === 0) {
    problems.push('the entrance needs at least one condition or one variable');
  }

  // Rules.
  const rules = definition.rules ?? [];
  if (rules.length > MAIL_TEMPLATE_LIMITS.maxRules) {
    problems.push(`more than ${MAIL_TEMPLATE_LIMITS.maxRules} rules`);
  }
  rules.forEach((rule, i) => {
    const at = `rules[${i}]`;
    if ('variable' in rule.target) {
      if (!variables.has(rule.target.variable)) {
        problems.push(`${at}: '${rule.target.variable}' is not a variable of ${spec.id}`);
      }
      if (rule.normalize !== undefined) {
        problems.push(`${at}: a variable uses its own kind; 'normalize' is for data targets`);
      }
    } else if ('data' in rule.target) {
      if (!DATA_PATH_RE.test(rule.target.data)) {
        problems.push(`${at}: data path '${rule.target.data}' must be dot-separated lower-case names, none of them __proto__, prototype or constructor`);
      }
      if (rule.normalize !== undefined && !MAIL_FACT_VARIABLE_KIND_SET.has(rule.normalize)) {
        problems.push(`${at}: normalize '${String(rule.normalize)}' is not a kind`);
      }
    } else {
      problems.push(`${at}: target must name a variable or a data path`);
    }
    if (!(MAIL_TEMPLATE_SOURCES as readonly string[]).includes(rule.source)) {
      problems.push(`${at}: source '${String(rule.source)}' is not one of ${MAIL_TEMPLATE_SOURCES.join(', ')}`);
    }
    if (rule.source === 'header' && (rule.header === undefined || !HEADER_NAME_RE.test(rule.header))) {
      problems.push(`${at}: a header source needs a header name`);
    }
    if (rule.source === 'html' && definition.html !== true) {
      problems.push(`${at}: reading HTML needs the template's html: true`);
    }
    if (rule.locale !== undefined && !LOCALE_RE.test(rule.locale)) {
      problems.push(`${at}: locale '${rule.locale}' is not a BCP 47 tag`);
    }
    const find = rule.find;
    switch (find?.kind) {
      case 'after_label':
        if (typeof find.label !== 'string' || !readsAsSomething(find.label)) {
          problems.push(`${at}: after_label needs a label`);
        }
        break;
      case 'pattern': {
        const problem = patternProblem(find.pattern, find.flags, true);
        if (problem !== null) problems.push(`${at}: pattern ${problem}`);
        break;
      }
      case 'whole':
        break;
      case 'constant':
        if (typeof find.value !== 'string' || find.value.length === 0) {
          problems.push(`${at}: constant needs a value`);
        }
        break;
      case 'keyword_map':
        if (!Array.isArray(find.cases) || find.cases.length === 0) {
          problems.push(`${at}: keyword_map needs cases`);
        } else if (find.cases.length > MAIL_TEMPLATE_LIMITS.maxKeywordCases) {
          problems.push(`${at}: more than ${MAIL_TEMPLATE_LIMITS.maxKeywordCases} cases`);
        } else {
          // A case of nothing is in every email: it would always be the one found.
          find.cases.forEach((c, j) => {
            if (!readsAsSomething(c.contains)) problems.push(`${at}: keyword_map case ${j + 1} needs text to look for`);
          });
        }
        break;
      case 'attachment':
        if (rule.source !== 'attachment') {
          problems.push(`${at}: an attachment finder needs source 'attachment'`);
        }
        if (typeof find.match !== 'string' || find.match.length === 0) {
          problems.push(`${at}: attachment needs a name or type to match`);
        }
        break;
      default:
        problems.push(`${at}: finder kind '${String((find as { kind?: unknown })?.kind)}' is not known`);
    }
    if (rule.source === 'attachment' && find?.kind !== 'attachment') {
      problems.push(`${at}: an attachment is picked, never read (ruling 25): use the attachment finder`);
    }
  });

  // Repeated block.
  if (definition.repeat !== undefined) {
    if (definition.repeat.source !== 'body' && definition.repeat.source !== 'html') {
      problems.push(`repeat.source must be body or html`);
    }
    if (definition.repeat.source === 'html' && definition.html !== true) {
      problems.push(`repeat on HTML needs the template's html: true`);
    }
    const problem = patternProblem(definition.repeat.split, 'i', false);
    if (problem !== null) problems.push(`repeat.split ${problem}`);
    // One that matches nothing at all splits at every character.
    else if (matchesEmpty(definition.repeat.split, 'i')) {
      problems.push('repeat.split matches an empty text, so it would split everywhere: it must match some text');
    }
  }

  // AI.
  const ai = definition.ai;
  if (ai === undefined || typeof ai.enabled !== 'boolean') {
    problems.push('ai must say enabled: true or false');
  } else if (ai.enabled) {
    if (typeof ai.prompt !== 'string' || ai.prompt.trim().length === 0) {
      problems.push('ai.prompt is required when the AI is on');
    } else if (ai.prompt.length > MAIL_TEMPLATE_LIMITS.maxPromptLength) {
      problems.push(`ai.prompt is longer than ${MAIL_TEMPLATE_LIMITS.maxPromptLength} characters`);
    }
    if (!(MAIL_FACT_POOL_POLICIES as readonly string[]).includes(ai.pool)) {
      problems.push(`ai.pool must be one of ${MAIL_FACT_POOL_POLICIES.join(', ')}`);
    }
    const entrance = new Set(entranceVariables);
    for (const slot of ai.slots ?? []) {
      if (slot.startsWith('data.')) {
        if (!DATA_PATH_RE.test(slot.slice('data.'.length))) {
          problems.push(`ai slot '${slot}' is not a data path (dot-separated lower-case names, none of them __proto__, prototype or constructor)`);
        }
      } else if (!variables.has(slot)) {
        problems.push(`ai slot '${slot}' is neither a variable of ${spec.id} nor a data path (data.<path>)`);
      } else if (entrance.has(slot)) {
        problems.push(`ai slot '${slot}' is an entrance variable; the AI never decides whether a fact exists (ruling 37)`);
      }
    }
    // More than the sender's domain: an exact address, or a subject or content
    // condition, or an entrance variable read from the email.
    if (!mailTemplateNarrowsPastDomain({ entrance: { conditions, variables: entranceVariables }, rules })) {
      problems.push(
        "an AI-on template's entrance needs more than the sender's domain: an address, a subject or content condition that not every email meets, or an entrance variable read after a label, by a pattern or by keywords (§4.1)",
      );
    }
  }
  return problems;
};

/** Bounds on an owner-created type (§4.5): its events carry every variable. */
export const MAIL_FACT_TYPE_LIMITS = {
  maxName: 80,
  maxDescription: 300,
  maxVariables: 30,
  maxValues: 50,
  maxStates: 30,
  maxIdentity: 3,
  maxIdentityVariables: 4,
  maxDataFields: 50,
} as const;

const TYPE_WORD_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** A name a fact's variable can have, in any kind of email: lower-case
 *  letters, digits and `_`, and not a reserved name — except `state` and
 *  `notice`, which a kind with states or notices has (§3.2). */
export const isMailFactVariableName = (name: string): boolean =>
  TYPE_WORD_RE.test(name)
  && (!MAIL_FACT_RESERVED_VARIABLE_NAMES.has(name) || name === MAIL_FACT_STATE_VARIABLE || name === MAIL_FACT_NOTICE_VARIABLE);

/** A state, a notice or an enum value as every kind of email writes it. */
export const isMailFactWord = (word: string): boolean => TYPE_WORD_RE.test(word);
const DATA_FIELD_KINDS: ReadonlySet<string> = new Set<string>([...MAIL_FACT_VARIABLE_KINDS, 'list', 'object']);

/** Problems with an owner-created type (§4.5), checked on its own. Whether its
 *  id or name is already taken is the store's to check. */
export const validateMailFactCustomType = (
  spec: MailFactTypeSpec,
  /** Variables the stored kind already declares: a name reserved since it was
   *  saved stays (a kind only grows, and its facts name it). */
  options: { readonly kept?: ReadonlySet<string> } = {},
): string[] => {
  const problems: string[] = [];
  if (!isMailFactCustomTypeId(spec.id)) {
    problems.push(`id '${String(spec.id)}' must be custom_ followed by lower-case letters, digits or _ (at most 40)`);
  }
  if (isMailFactBuiltinTypeId(String(spec.id).replace(/^custom_/, ''))) {
    // `custom_shipment` is a distinct id from `shipment`, but a slug equal to a
    // built-in type is refused (§4.5) so the two never read alike.
    problems.push(`'${String(spec.id)}' reads like the built-in type '${String(spec.id).replace(/^custom_/, '')}'`);
  }
  if (typeof spec.name !== 'string' || spec.name.trim().length === 0) {
    problems.push('name is required');
  } else if (spec.name.length > MAIL_FACT_TYPE_LIMITS.maxName) {
    problems.push(`name is longer than ${MAIL_FACT_TYPE_LIMITS.maxName} characters`);
  }
  if (typeof spec.description !== 'string') {
    problems.push('description must be text (it may be empty)');
  } else if (spec.description.length > MAIL_FACT_TYPE_LIMITS.maxDescription) {
    problems.push(`description is longer than ${MAIL_FACT_TYPE_LIMITS.maxDescription} characters`);
  }

  const variables = Array.isArray(spec.variables) ? spec.variables : [];
  if (variables.length === 0) problems.push('a kind of email needs at least one variable');
  if (variables.length > MAIL_FACT_TYPE_LIMITS.maxVariables) {
    problems.push(`more than ${MAIL_FACT_TYPE_LIMITS.maxVariables} variables`);
  }
  const seen = new Map<string, MailFactVariableKind>();
  for (const variable of variables) {
    if (!TYPE_WORD_RE.test(variable.name)) {
      problems.push(`variable '${variable.name}' must be lower-case letters, digits or _`);
    }
    if (MAIL_FACT_RESERVED_VARIABLE_NAMES.has(variable.name) && options.kept?.has(variable.name) !== true) {
      problems.push(`variable '${variable.name}' is a reserved name`);
    }
    if (seen.has(variable.name)) problems.push(`variable '${variable.name}' is declared twice`);
    // The name carries its rule (§3.1): only its last four characters are kept.
    if (variable.name === 'account_ref' && variable.kind !== 'text') {
      problems.push("variable 'account_ref' holds an account's last four characters: it is text");
    }
    seen.set(variable.name, variable.kind);
    if (!MAIL_FACT_VARIABLE_KIND_SET.has(variable.kind)) {
      problems.push(`variable '${variable.name}' has an unknown kind '${String(variable.kind)}'`);
    }
    if (typeof variable.required !== 'boolean') {
      problems.push(`variable '${variable.name}' must say whether it is required`);
    }
    if (variable.kind === 'enum') {
      const values = variable.values ?? [];
      if (values.length === 0) problems.push(`variable '${variable.name}' is an enum with no values`);
      if (values.length > MAIL_FACT_TYPE_LIMITS.maxValues) {
        problems.push(`variable '${variable.name}' has more than ${MAIL_FACT_TYPE_LIMITS.maxValues} values`);
      }
      for (const value of values) {
        if (!TYPE_WORD_RE.test(value)) {
          problems.push(`variable '${variable.name}': value '${value}' must be lower-case letters, digits or _`);
        }
      }
      if (new Set(values).size !== values.length) problems.push(`variable '${variable.name}' repeats a value`);
    } else if (variable.values !== undefined) {
      problems.push(`variable '${variable.name}': only an enum declares values`);
    }
    if (variable.description !== undefined && variable.description.length > MAIL_FACT_TYPE_LIMITS.maxDescription) {
      problems.push(`variable '${variable.name}': description is longer than ${MAIL_FACT_TYPE_LIMITS.maxDescription} characters`);
    }
  }

  for (const [label, list] of [['state', spec.states], ['notice', spec.notices]] as const) {
    const words = Array.isArray(list) ? list : [];
    if (words.length > MAIL_FACT_TYPE_LIMITS.maxStates) problems.push(`more than ${MAIL_FACT_TYPE_LIMITS.maxStates} ${label}s`);
    for (const word of words) {
      if (!TYPE_WORD_RE.test(word)) problems.push(`${label} '${word}' must be lower-case letters, digits or _`);
    }
    if (new Set(words).size !== words.length) problems.push(`a ${label} is listed twice`);
  }

  const identity = Array.isArray(spec.identity) ? spec.identity : [];
  if (identity.length > MAIL_FACT_TYPE_LIMITS.maxIdentity) {
    problems.push(`more than ${MAIL_FACT_TYPE_LIMITS.maxIdentity} ways to tell one thing from another`);
  }
  for (const alternative of identity) {
    if (alternative.length === 0 || alternative.length > MAIL_FACT_TYPE_LIMITS.maxIdentityVariables) {
      problems.push(`an identity names 1 to ${MAIL_FACT_TYPE_LIMITS.maxIdentityVariables} variables`);
    }
    for (const name of alternative) {
      const kind = seen.get(name);
      if (kind === undefined) problems.push(`identity names '${name}', which is not a declared variable`);
      else if (kind === 'file') problems.push(`identity names '${name}': an attachment cannot tell one thing from another`);
    }
  }

  const dataFields = spec.data_fields ?? [];
  if (dataFields.length > MAIL_FACT_TYPE_LIMITS.maxDataFields) {
    problems.push(`more than ${MAIL_FACT_TYPE_LIMITS.maxDataFields} data fields`);
  }
  const paths = new Set<string>();
  for (const field of dataFields) {
    if (!DATA_PATH_RE.test(field.path)) problems.push(`data field '${field.path}' must be dot-separated lower-case names, none of them __proto__, prototype or constructor`);
    if (paths.has(field.path)) problems.push(`data field '${field.path}' is declared twice`);
    paths.add(field.path);
    if (!DATA_FIELD_KINDS.has(field.kind)) problems.push(`data field '${field.path}' has an unknown kind '${String(field.kind)}'`);
    if (field.description !== undefined && field.description.length > MAIL_FACT_TYPE_LIMITS.maxDescription) {
      problems.push(`data field '${field.path}': description is longer than ${MAIL_FACT_TYPE_LIMITS.maxDescription} characters`);
    }
  }
  return problems;
};

/** An owner type only grows once saved (§4.5, as built in slice 5): its facts,
 *  templates and triggers name its variables, values and states. A variable
 *  may gain values, a description or be (un)required, and new ones may be
 *  added; nothing may be removed, renamed or change its kind, and how one
 *  thing is told from another stays — it decided which thing each fact joined. */
export const validateMailFactTypeChange = (before: MailFactTypeSpec, after: MailFactTypeSpec): string[] => {
  const problems: string[] = [];
  if (after.id !== before.id) problems.push('a kind of email keeps its id');
  const now = new Map(after.variables.map((variable) => [variable.name, variable]));
  for (const variable of before.variables) {
    const next = now.get(variable.name);
    if (next === undefined) {
      problems.push(`variable '${variable.name}' cannot be removed: facts, templates and triggers name it`);
      continue;
    }
    if (next.kind !== variable.kind) {
      problems.push(`variable '${variable.name}' keeps its kind (${variable.kind}): facts stored it as one`);
    }
    for (const value of variable.values ?? []) {
      if (!(next.values ?? []).includes(value)) {
        problems.push(`variable '${variable.name}' keeps its value '${value}': facts and triggers name it`);
      }
    }
  }
  for (const [label, was, is] of [['state', before.states, after.states], ['notice', before.notices, after.notices]] as const) {
    for (const word of was) {
      if (!is.includes(word)) problems.push(`the ${label} '${word}' cannot be removed: facts and triggers name it`);
    }
  }
  const key = (identity: readonly (readonly string[])[]): string =>
    JSON.stringify(identity.map((alternative) => [...alternative].sort()).sort());
  if (key(before.identity) !== key(after.identity)) {
    problems.push('how one thing is told from another cannot change: it decided which thing each fact joined');
  }
  return problems;
};
