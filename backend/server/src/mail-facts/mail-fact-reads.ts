/**
 * D-315 — the reads behind `core.mail.fact.get` / `core.mail.fact.list` (§5).
 *
 * Read tier, dispatched under `data.mail`: a fact is derived from mail, so
 * reading one through any door needs the same access as reading the mail. The
 * kernel checks the input's shape before it gets here (`parseMailFactListInput`
 * in `packages/ingredients/src/kernel.ts`).
 *
 *   - `get` takes a thing id or a fact id: a thing comes back with its facts
 *     (each names its email, for `core.mail.get`), a fact with its thing.
 *   - `list` returns things (default) or facts, newest first. An identity is
 *     matched the way the writer stored it: each value normalized for its
 *     variable's kind, so `1Z 999 AA1` finds the parcel stored as `1Z999AA1`
 *     — and, as the writer joins, never a thing whose identity disagrees: two
 *     returns of one order, asked for by return id R-2, answer R-2 alone.
 */

import {
  getMailFactBuiltinType,
  MAIL_FACT_LIST_DEFAULT_LIMIT,
  mailFactTypeVariables,
  type MailFact,
  type MailFactGetResult,
  type MailFactListInput,
  type MailFactThing,
  type MailFactTypeSpec,
  type MailFactValue,
} from '@recued/contracts';

import type { MailFactStore } from '../storage/mail-fact-store.js';

import { normalizeHeldValue } from './normalize.js';
import { identitiesDisagree, identityKeysOf } from './thing-fold.js';

const typeSpecOf = (store: MailFactStore, type: string): MailFactTypeSpec | undefined =>
  getMailFactBuiltinType(type) ?? store.getCustomType(type) ?? undefined;

export const readMailFact = (store: MailFactStore, id: string): MailFactGetResult => {
  const thing = store.getThing(id);
  if (thing !== null) return { thing, facts: store.factsForThing(id) };
  const fact = store.getFact(id);
  if (fact === null) return { thing: null, facts: [] };
  // An unpaired standards fact joins no thing (§4).
  return { thing: fact.thing_id === null ? null : store.getThing(fact.thing_id), facts: [fact] };
};

/** The things an identity names, oldest first: every thing holding one of its
 *  keys whose identity does not disagree with it. A value that does not
 *  normalize for its variable's kind names nothing, and a variable the type
 *  does not have cannot be part of an identity. */
const thingByIdentity = (
  store: MailFactStore,
  spec: MailFactTypeSpec,
  identity: Readonly<Record<string, string>>,
): MailFactThing[] => {
  const variables = new Map(mailFactTypeVariables(spec).map((variable) => [variable.name, variable]));
  const values: Record<string, MailFactValue | null> = {};
  for (const [name, raw] of Object.entries(identity)) {
    const variable = variables.get(name);
    if (variable === undefined) return [];
    // As the thing holds it: `1.125` is not the thousands an email's can be.
    const normalized = normalizeHeldValue(raw, variable.kind, {
      ...(variable.values !== undefined ? { values: variable.values } : {}),
      variable: name,
    });
    if (!normalized.ok) return [];
    values[name] = normalized.value;
  }
  const keys = identityKeysOf(spec, values);
  if (keys.length === 0) return [];
  return store.thingsHoldingKeys(spec.id, keys).filter((thing) => !identitiesDisagree(keys, thing.identity_keys));
};

export const listMailFacts = (
  store: MailFactStore,
  query: MailFactListInput,
): readonly (MailFactThing | MailFact)[] => {
  const limit = query.limit ?? MAIL_FACT_LIST_DEFAULT_LIMIT;
  if (query.of === 'facts') {
    return store.listFacts({
      ...(query.type !== undefined ? { type: query.type } : {}),
      ...(query.since !== undefined ? { since: query.since } : {}),
      limit,
    });
  }
  if (query.identity !== undefined) {
    const spec = query.type === undefined ? undefined : typeSpecOf(store, query.type);
    if (spec === undefined) return [];
    return thingByIdentity(store, spec, query.identity).filter((thing) =>
      (query.state === undefined || thing.variables.state === query.state)
      && (query.since === undefined || thing.updated_at >= query.since)).slice(0, limit);
  }
  return store.listThings({
    ...(query.type !== undefined ? { type: query.type } : {}),
    ...(query.state !== undefined ? { state: query.state } : {}),
    ...(query.since !== undefined ? { since: query.since } : {}),
    limit,
  });
};
