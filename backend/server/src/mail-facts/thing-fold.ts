/**
 * D-315 — a thing is a fold of its facts (§3.1, §5).
 *
 * Several emails about one parcel, order or booking are one thing, found by the
 * type's identity. The thing is DERIVED: its variables are recomputed from all
 * of its facts whenever one is added, replaced or deleted, so re-extraction,
 * deletion and mail arriving out of order all give the same answer.
 *
 *   - each variable takes the value of the NEWEST fact (by the email's date)
 *     that read it, so a later email that lacks an order number does not erase
 *     the one an earlier email gave;
 *   - `state` is the state of the newest fact that has one: a resync or a
 *     backfill of older mail never moves `delivered` back to `in_transit`;
 *   - a notice never changes the state — `notice` is its own variable, and it
 *     is what the NEWEST email said: an email after a reminder that says
 *     nothing of one (the payment) leaves no notice, so a trigger on
 *     `notice: reminder` does not wake for it;
 *   - `last_email_at` is when its newest email arrived, so a newer email
 *     changes it even when it says nothing new (ruling 44).
 *
 * Events come from diffing the thing before and after (§5): `created` lists
 * every variable read, and `last_email_at`; `updated` lists what changed, and
 * `notice` whenever the incoming fact carries the thing's newest notice, so a
 * second reminder still counts — and not when a notice only went. A fact that
 * changes nothing, its time included
 * — an older email, a re-read of the same one — emits nothing. One that changes
 * only the time is still an event: the dispatcher hands it only to a trigger
 * that asked for every email (`matchesTriggerDispatchFilter`).
 *
 * Spec: D-315 §3.1, §5, §5.1.
 */

import {
  MAIL_FACT_LAST_EMAIL_AT,
  MAIL_FACT_NOTICE_VARIABLE,
  mailFactTypeVariables,
  type MailFactEmailRef,
  type MailFactPass,
  type MailFactTypeSpec,
  type MailFactValue,
  type MailFactVariableKind,
} from '@recued/contracts';

import { identityValueKey } from './normalize.js';

/** What the fold reads from each fact. */
export interface ThingFoldFact {
  readonly fact_id: string;
  /** Its email: a notice is the newest email's, any block of it. */
  readonly email?: MailFactEmailRef;
  readonly email_at: number;
  /** Its email's place in the order mail was first read: of two of one date,
   *  the later is the newer. */
  readonly arrival?: number;
  readonly created_at: number;
  readonly variables: Readonly<Record<string, MailFactValue | null>>;
  readonly passes: Readonly<Record<string, MailFactPass>>;
}

export interface FoldedThing {
  /** Every variable of the type, `null` when no fact read it. */
  readonly variables: Readonly<Record<string, MailFactValue | null>>;
  readonly passes: Readonly<Record<string, MailFactPass>>;
  /** Per variable: the date of the email whose fact gave its value. */
  readonly variable_email_at: Readonly<Record<string, number>>;
  /** Per variable: the fact that gave its value. */
  readonly variable_fact: Readonly<Record<string, string>>;
  /** When the newest of its emails arrived. */
  readonly last_email_at: number;
  /** The newest of its emails by the fold's own order — of two of one date,
   *  the one read last: each email that becomes it is news to a recipe on
   *  every email, the same date or not (ruling 44). */
  readonly last_email?: MailFactEmailRef;
  readonly missing: readonly string[];
  readonly complete: boolean;
}

/** The keys a fact's variables form, one per identity alternative whose
 *  variables were all read (§3.1). A fact joins the thing sharing any key. */
export const identityKeysOf = (
  spec: MailFactTypeSpec,
  variables: Readonly<Record<string, MailFactValue | null>>,
): string[] => {
  const kinds = new Map(mailFactTypeVariables(spec).map((variable) => [variable.name, variable.kind]));
  const keys: string[] = [];
  for (const alternative of spec.identity) {
    const values = alternative.map((name) => {
      const value = variables[name] ?? null;
      return value === null ? '' : identityValueKey(value, kinds.get(name), name);
    });
    if (values.some((value) => value === '')) continue;
    keys.push(`${alternative.join('+')}=${values.join('|')}`);
  }
  return keys;
};

/** The identity alternative a key belongs to: `merchant+order_id=…` →
 *  `merchant+order_id`. */
const alternativeOf = (key: string): string => key.slice(0, key.indexOf('='));

/** Whether two sets of identity keys disagree: an alternative both have, with
 *  no value in common — two returns of one order, told apart by their return
 *  ids, are two things however much else they share. The writer joins no thing
 *  it disagrees with, and a lookup by identity returns none. */
export const identitiesDisagree = (a: readonly string[], b: readonly string[]): boolean =>
  a.some((key) => {
    const alternative = alternativeOf(key);
    const same = b.filter((other) => alternativeOf(other) === alternative);
    return same.length > 0 && !same.includes(key);
  });

/** Newest first: the email's date, then the order mail was first read in —
 *  of two emails of one date, the one read after — then when the fact was
 *  made. Never a random id while anything else can tell them apart. */
const newestFirst = (a: ThingFoldFact, b: ThingFoldFact): number =>
  b.email_at - a.email_at
  || (b.arrival ?? 0) - (a.arrival ?? 0)
  || b.created_at - a.created_at
  || (a.fact_id < b.fact_id ? 1 : -1);

export const foldThing = (spec: MailFactTypeSpec, facts: readonly ThingFoldFact[]): FoldedThing => {
  const ordered = [...facts].sort(newestFirst);
  const variables: Record<string, MailFactValue | null> = {};
  const passes: Record<string, MailFactPass> = {};
  const variableEmailAt: Record<string, number> = {};
  const variableFact: Record<string, string> = {};
  const newest = ordered[0];
  /** Of the newest email by this order — of two emails of one date, the one
   *  read last, never the other — any block of it. */
  const ofNewestEmail = (fact: ThingFoldFact): boolean => fact === newest
    || (fact.email !== undefined && newest?.email !== undefined
      && fact.email.slug === newest.email.slug && fact.email.record_id === newest.email.record_id);
  for (const variable of mailFactTypeVariables(spec)) {
    variables[variable.name] = null;
    // A notice is the newest email's, or none.
    const provider = ordered.find((fact) => (fact.variables[variable.name] ?? null) !== null
      && (variable.name !== MAIL_FACT_NOTICE_VARIABLE || ofNewestEmail(fact)));
    if (provider === undefined) continue;
    variables[variable.name] = provider.variables[variable.name]!;
    const pass = provider.passes[variable.name];
    if (pass !== undefined) passes[variable.name] = pass;
    variableEmailAt[variable.name] = provider.email_at;
    variableFact[variable.name] = provider.fact_id;
  }
  const missing = spec.variables
    .filter((variable) => variable.required && variables[variable.name] === null)
    .map((variable) => variable.name);
  return {
    variables,
    passes,
    variable_email_at: variableEmailAt,
    variable_fact: variableFact,
    last_email_at: facts.reduce((newest, fact) => Math.max(newest, fact.email_at), 0),
    ...(newest?.email !== undefined ? { last_email: newest.email } : {}),
    missing,
    complete: missing.length === 0,
  };
};

export interface ThingChange {
  readonly kind: 'created' | 'updated';
  /** Always present on a fact event (§5.1): the `fields` filter reads it. */
  readonly changed_fields: readonly string[];
}

/** Two values of a variable alike, as identities compare them: an amount by
 *  its value (`12.50`, then `12.5`) and a time by its instant (`10:00+01:00`,
 *  then `09:00Z`), so either written again another way is no change. */
const sameValue = (kind: MailFactVariableKind | undefined, a: MailFactValue | null, b: MailFactValue | null): boolean => {
  if (a === null || b === null) return a === b;
  if (typeof a === 'object' && typeof b === 'object') return identityValueKey(a) === identityValueKey(b);
  if (kind === 'datetime' && typeof a === 'string' && typeof b === 'string') {
    return identityValueKey(a, 'datetime') === identityValueKey(b, 'datetime');
  }
  return JSON.stringify(a) === JSON.stringify(b);
};

/** The event a thing's change deserves, or `null` when nothing a subscriber can
 *  see changed. `incoming` is the fact (or, for one email's repeated blocks,
 *  the facts) that caused the change; a deletion passes `null` and emits
 *  nothing (a deleted email is not news). */
export const diffThing = (
  spec: MailFactTypeSpec,
  before: FoldedThing | null,
  after: FoldedThing,
  incoming: string | ReadonlySet<string> | null,
): ThingChange | null => {
  if (incoming === null) return null;
  const incomingIds: ReadonlySet<string> = typeof incoming === 'string' ? new Set([incoming]) : incoming;
  if (incomingIds.size === 0) return null;
  const names = Object.keys(after.variables);
  if (before === null) {
    const read = names.filter((name) => after.variables[name] !== null);
    return { kind: 'created', changed_fields: [...read, MAIL_FACT_LAST_EMAIL_AT] };
  }
  const kinds = new Map(mailFactTypeVariables(spec).map((variable) => [variable.name, variable.kind]));
  const changed = names.filter((name) => name !== MAIL_FACT_NOTICE_VARIABLE
    && !sameValue(kinds.get(name), before.variables[name] ?? null, after.variables[name] ?? null));
  // A newer email — of a later date, or of the same date and read after —
  // is news to a recipe on every email, though it says nothing new.
  const newerEmail = after.last_email !== undefined && before.last_email !== undefined
    && (after.last_email.slug !== before.last_email.slug || after.last_email.record_id !== before.last_email.record_id);
  if (after.last_email_at !== before.last_email_at || newerEmail) changed.push(MAIL_FACT_LAST_EMAIL_AT);
  // A notice counts when one arrives — every time the incoming fact carries the
  // thing's newest one, even when its value repeats (a second reminder) — and
  // not when it only went.
  const noticeFact = after.variable_fact[MAIL_FACT_NOTICE_VARIABLE];
  if (noticeFact !== undefined && incomingIds.has(noticeFact)) changed.push(MAIL_FACT_NOTICE_VARIABLE);
  // Once each: an owner's kind saved before `last_email_at` was reserved may
  // declare a variable of that name too.
  return changed.length === 0 ? null : { kind: 'updated', changed_fields: [...new Set(changed)] };
};
