/**
 * D-315 — the fact writer: one email in, facts and thing events out (§4, §5).
 *
 *   read before with this content, and no label or relationship a template
 *             tests has come or gone since? → skip. A template made or changed
 *             reads past mail only when a backfill asks (ruling 13, `force`)
 *   a security notice, and not the owner's own request? → skip, best effort
 *             (§9); facts it had go
 *   per type: the most specific template that meets its entrance wins (§4.1);
 *             every template tried records its outcome for health (§6.2)
 *   one transaction: the reading replaces the email's facts from the templates
 *             that are on and the standards types that are on — a fact of a
 *             template switched off or deleted stays with its email. A fact
 *             read again keeps its id and its thing, and when nothing it was
 *             read from changed it stays as it was, the AI's answers included.
 *             Each fact joins the thing sharing any of its identity keys, unless
 *             their identities disagree, or starts one; a fact that names two
 *             things makes them one. Every affected thing is re-folded
 *   after commit: a `created` / `updated` event per thing that news changed.
 *             News is an email seen for the first time, its mailbox past its
 *             first backfill (§5) — kept in the ledger from the moment its row
 *             lands, so a stop before its facts are read does not lose it — or
 *             a backfill that runs recipes. A fact announces once: reading it
 *             again never fires again
 *
 * Deleting an email deletes its facts and re-folds their things silently; a
 * thing left with no facts goes too (rulings 11, 29). A moved email keeps its
 * facts under its new id.
 *
 * The standards pass (§7.1) runs beside the templates, and its facts are paired
 * with theirs by the rule of §4: the same identity key, the same ids where the
 * identity names both a name and an id, or exactly one fact from each pass
 * whose identities do not disagree. In a pair the owner's rule wins and the
 * standards pass fills what is left. A standards fact left over is its own
 * thing — unless a template fact that read no identity is left too, when it
 * might be that fact's thing: then it is kept UNPAIRED, joins no thing and
 * triggers nothing, since pairing by guess could cross two parcels' values.
 *
 * The AI pass (§4.3) comes last. A fact whose template has the AI on and a
 * slot still empty is stored WAITING: it joins no thing and starts nothing, and
 * one AI call per email and template is queued (`mail_fact_ai_job`), so a
 * restart loses nothing. `applyAi` then places it — the thing is found after
 * the AI, since an identity it fills decides which thing the fact joins
 * (ruling 39) — and fires what its change fires. An AI that cannot answer
 * places it all the same, on what the rules read.
 *
 * Spec: D-315 §4, §4.1, §5, §5.3, §9.
 */

import { createHash } from 'node:crypto';

import {
  MAIL_FACT_EVENT_ENTITY_TYPE,
  MAIL_FACT_EVENT_PLATFORM,
  getMailFactBuiltinType,
  isMailFactCustomTypeId,
  mailFactDataAt,
  mailFactEmptyAiSlots,
  mailFactTypeVariables,
  type MailFact,
  type MailFactAi,
  type MailFactEmailRef,
  type MailFactPass,
  type MailFactThing,
  type MailFactTriggerRecord,
  type MailFactTypeSpec,
  type MailFactValue,
  type MailTemplate,
  type MailTemplateCondition,
} from '@recued/contracts';
import type { WarehouseEvent } from '@recued/warehouse-events';

import type { MailFactAiJob, MailFactStore, StoredMailFact } from '../storage/mail-fact-store.js';
import { identityValueKey, MAIL_FACT_NAME_VARIABLES, MAIL_FACT_READING_VERSION } from './normalize.js';
import { readAsSent, recognizeOwnerRequest } from './owner-request.js';
import { labelAsRead, runRulesPass, setPath, type MailFactSourceEmail, type RulesPassFact } from './rules-pass.js';
import { byWhatItSays, couldBeOne, pairEach, thingGroups } from './matching.js';
import { looksLikeSecurityNotice } from './security-notice.js';
import { diffThing, foldThing, identitiesDisagree, identityKeysOf, type FoldedThing } from './thing-fold.js';
import {
  combineFacts,
  combineFactsByPass,
  MAIL_FACT_STANDARDS_VERSION,
  runStandardsPass,
  type MailFactEnvelope,
  type StandardsFact,
} from './standards-pass.js';

export interface MailFactWriterDeps {
  readonly store: MailFactStore;
  /** The warehouse bus's `emit`. */
  readonly emit: (event: WarehouseEvent) => void;
  readonly now: () => number;
  readonly logger?: { warn(message: string, detail?: unknown): void };
  readonly isSecurityNotice?: (email: MailFactSourceEmail) => boolean;
  /** After a commit: an email's facts were written, removed or moved
   *  (`facts`), or a template's health moved (`templates`). The screens
   *  refresh on it (§6); it must not throw. */
  readonly onChanged?: (what: MailFactChange) => void;
  /** After a commit that queued the AI pass (§4.3): start it. Must not throw. */
  readonly onAiQueued?: () => void;
}

export type MailFactChange = 'facts' | 'templates';

/** What the AI pass made of one waiting fact (§4.3): its reading after the
 *  AI, finished as every pass finishes it (§9), and how the AI went. */
export interface MailFactAiReading {
  readonly fact_id: string;
  readonly reading: Pick<RulesPassFact, 'variables' | 'passes' | 'data' | 'refused' | 'missing' | 'complete'>;
  readonly ai: Extract<MailFactAi, { state: 'read' | 'not_read' }>;
}

export interface MailFactWriteInput {
  readonly ref: MailFactEmailRef;
  readonly email: MailFactSourceEmail;
  /** The email's own date, which orders a thing's state — never later than
   *  when it was stored (the ingest clamps it). */
  readonly email_at: number;
  /** The email's content, fingerprinted: a label change leaves it unchanged.
   *  The labels and relationships a template tests are the writer's to compare,
   *  so a flag flip re-reads nothing while a label the owner adds later still
   *  lets a label-conditioned template read the email. */
  readonly content_fingerprint: string;
  /** News: new to the store, and its mailbox past its first backfill (§5); or a
   *  backfill that runs the recipes its facts trigger (§6.3). */
  readonly may_trigger: boolean;
  /** Count template health for this reading: true the first time an email is
   *  read (and on a manual backfill), false when a restart re-lists it. */
  readonly count_health: boolean;
  /** What the ingest knows beyond the content; owner requests need it (§7.4).
   *  Absent ⇒ none is recognized. */
  readonly envelope?: MailFactEnvelope;
  /** D-315 §6.3 — a backfill that runs the recipes its facts trigger stamps
   *  its events, so those runs are `run_mode: backfill`. */
  readonly origin?: 'backfill';
  /** §6.3 — a backfill reads again an email that was read already. */
  readonly force?: boolean;
  /** §6.3 — the template a backfill reads for: only its health is counted, and
   *  only its facts may start recipes. */
  readonly backfill_template?: string;
}

export type MailFactWriteSkip = 'security_notice' | 'unchanged';

export interface MailFactWriteResult {
  readonly skipped?: MailFactWriteSkip;
  /** Facts this reading wrote, new or changed — a fact read again unchanged is
   *  not one. Skipped as unchanged: the facts the email has. */
  readonly facts: number;
  readonly events: number;
}

export interface MailFactWriter {
  write(input: MailFactWriteInput): MailFactWriteResult;
  /** §5 — an email seen for the first time is news, from the moment its row
   *  lands: a stop or a crash before its facts are read keeps it news. */
  markNews(ref: MailFactEmailRef): void;
  /** §4.3 — the AI pass answered (or could not): place the facts it read and
   *  fire what their change fires, then retire the job. An answer to a job
   *  queued again since settles nothing. */
  applyAi(job: MailFactAiJob, readings: readonly MailFactAiReading[]): MailFactWriteResult;
  /** An email was deleted, pruned or dropped from sync: its facts go, and their
   *  things re-fold silently. */
  removeEmails(slug: string, record_ids: readonly string[]): void;
  /** An email moved and was given a new id: its facts follow it. */
  rekeyEmail(slug: string, old_record_id: string, new_record_id: string): void;
  /** §5.3 — what a delete or a move whose hook failed left behind: one page of
   *  a live mailbox's emails from `after`, each the mailbox no longer holds
   *  removed as a deleted one is. Returns where the next page starts, or null
   *  at the end. */
  sweepGone(slug: string, holds: (record_id: string) => boolean, after: string | null): string | null;
}

/** §5 — one copy of an email: its Message-ID, subject and text, and where the
 *  copy sits — its folder and labels, and whether the account sent it. The
 *  same message found again in the same place under another id (an IMAP
 *  folder whose ids were reset) shares it; its attachments' ids do not count.
 *  A copy elsewhere is its own sighting: the Sent copy of an email to yourself
 *  is the request its Inbox copy is not, and a folder a template tests reads
 *  what the Inbox does not. `null` without a Message-ID: nothing then says two
 *  emails are one. */
export const mailFactCopyKey = (email: MailFactSourceEmail, envelope: MailFactEnvelope | undefined): string | null => {
  const id = envelope?.rfc_message_id ?? null;
  if (id === null || id === '') return null;
  const where = [...new Set(email.labels.map((label) => label.toLowerCase()))].sort().join('\u0000');
  const hash = createHash('sha256');
  for (const part of [id, email.from_address, email.subject, email.body_text, where, envelope?.sent_by_account === true ? 'sent' : '']) {
    hash.update(String(part.length)).update(':').update(part);
  }
  return hash.digest('hex');
};

/** Emails a sweep looks at per page. */
export const MAIL_FACT_SWEEP_PAGE = 500;

/** Facts one settling of things reads at most (§5): past this many around the
 *  keys a write touched, what was placed stands — a region this wide is no one
 *  thing's, and each write would read it whole. */
export const MAIL_FACT_SETTLE_MAX_FACTS = 2_000;

/** §5.3 — at boot, once the mailboxes are live: each one's emails that it no
 *  longer holds lose their facts, as a deleted email's do. A delete or a move
 *  hook runs once and a failure there is only logged, so this is what makes a
 *  fact follow its email in the end. A page per turn of the event loop. */
export const sweepGoneEmails = async (
  writer: Pick<MailFactWriter, 'sweepGone'>,
  mailboxes: readonly { readonly slug: string; get(record_id: string): unknown }[],
  logger?: { warn(message: string, detail?: unknown): void },
): Promise<void> => {
  for (const mailbox of mailboxes) {
    try {
      let after: string | null = null;
      do {
        after = writer.sweepGone(mailbox.slug, (record_id) => mailbox.get(record_id) !== null, after);
        await new Promise<void>((resolve) => { setImmediate(resolve); });
      } while (after !== null);
    } catch (error) {
      logger?.warn('mail fact: the sweep of a mailbox stopped', { error, slug: mailbox.slug });
    }
  }
};

/** How specific a template's conditions are (§4.1): an address beats a domain,
 *  which beats a subject alone. At equal specificity the older template wins. */
export const templateSpecificity = (conditions: readonly MailTemplateCondition[]): number => {
  let score = 0;
  for (const condition of conditions) {
    if (condition.negate === true) continue;
    if (condition.field === 'from' && condition.op === 'is') score = Math.max(score, 3);
    else if (condition.field === 'from') score = Math.max(score, 2);
    else score = Math.max(score, 1);
  }
  return score;
};

const typeSpecOf = (store: MailFactStore, type: string): MailFactTypeSpec | undefined =>
  getMailFactBuiltinType(type) ?? store.getCustomType(type) ?? undefined;

/** An email's labels and its sender's relationships, as the ledger keeps them:
 *  as a template reads them (`labelAsRead`), so a fullwidth label a condition
 *  meets is the one it names, come or gone. */
const labelsOf = (email: MailFactSourceEmail): string[] => [...new Set([
  ...email.labels.map(labelAsRead),
  ...email.relationships.map((relationship) => `relationship:${labelAsRead(relationship)}`),
])].sort();

/** Whether a label or relationship a template tests has come or gone since the
 *  email was last read: only those can change what a template reads. */
const testedLabelsMoved = (
  templates: readonly MailTemplate[],
  before: readonly string[],
  now: readonly string[],
): boolean => {
  const tested = new Set<string>();
  for (const template of templates) {
    for (const condition of template.entrance.conditions) {
      if (condition.field === 'label') tested.add(labelAsRead(condition.value));
      if (condition.field === 'relationship') tested.add(`relationship:${labelAsRead(condition.value)}`);
    }
  }
  if (tested.size === 0) return false;
  const seen = (labels: readonly string[]): string => labels.filter((label) => tested.has(label)).sort().join('\n');
  return seen(before) !== seen(now);
};

/** What a fact was read from: the email's content, the revision of the
 *  template that read it, the standards pass — whether it was off for the
 *  kind (§7.1) — the reader that read its values (`MAIL_FACT_READING_VERSION`),
 *  and an owner's kind of email as its readings see it (§4.5): its variables,
 *  identity, states and notices, not its name. That kind can grow, and mail
 *  read before is then read anew; a built-in kind changes only with the
 *  server, as the standards pass and the reader do. Unchanged ⇒ reading it
 *  again gives the same fact, so the one stored stays — the AI's answers
 *  included. `readingVersion` is for a test that stores what an older reader read. */
export const factSourceHash = (
  fingerprint: string,
  template: MailTemplate | undefined,
  spec: MailFactTypeSpec,
  standardsOff: boolean,
  readingVersion: number = MAIL_FACT_READING_VERSION,
): string => {
  const hash = createHash('sha256')
    .update(fingerprint)
    .update('\u0000')
    .update(template === undefined ? '-' : `${template.template_id}@${template.revision}`)
    .update('\u0000')
    .update(`standards@${MAIL_FACT_STANDARDS_VERSION}`)
    .update('\u0000')
    .update(`reading@${readingVersion}`);
  if (standardsOff) hash.update('\u0000').update('standards-off');
  if (isMailFactCustomTypeId(spec.id)) {
    hash.update('\u0000').update(stable({ variables: spec.variables, identity: spec.identity, states: spec.states, notices: spec.notices }));
  }
  return hash.digest('hex');
};

/** JSON with every object's keys in order, to compare two readings. */
const stable = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item !== null && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : item);

const sameReading = (fact: MailFact, read: RulesPassFact): boolean =>
  stable([fact.variables, fact.passes, fact.data, fact.missing, fact.refused])
    === stable([read.variables, read.passes, read.data, read.missing, read.refused]);

/** A fact to store, and whether it joins a thing. */
interface PlannedFact {
  readonly spec: MailFactTypeSpec;
  readonly template_id: string | null;
  readonly read: RulesPassFact;
  /** An unpaired standards fact (§4): stored and shown, joins no thing. */
  readonly unpaired: boolean;
  /** A template's reading that took a standards reading in: it holds that one,
   *  and no other. */
  readonly partnered: boolean;
}

/** The date an email's facts are ordered by (§5): fixed when it was first
 *  read; read before the date was kept, the date its facts have; not read yet,
 *  `fallback` — its own date, never later than now. A backfill replays mail in
 *  this order: a future-dated email read before the mail that came since is
 *  older than that mail, whatever its own date says. */
export const mailFactEmailDate = (
  store: Pick<MailFactStore, 'getEmailLedger' | 'factRecordsForEmail'>,
  email: MailFactEmailRef,
  fallback: number,
): number => {
  const kept = store.getEmailLedger(email)?.email_at;
  if (kept !== undefined && kept !== null) return kept;
  const facts = store.factRecordsForEmail(email);
  return facts.length > 0 ? Math.min(...facts.map((fact) => fact.email_at)) : fallback;
};

/** What pairing reads of a fact or a reading. */
type PairingReading = { readonly variables: Readonly<Record<string, MailFactValue | null>> };

/** No part of an identity both readings read disagrees — a name aside, which
 *  may be written differently (§4). An invoice number of one issuer in two
 *  periods is two invoices, and INV-2 is not INV-1 whether or not either read
 *  the issuer. */
const partsAgree = (spec: MailFactTypeSpec, a: PairingReading, b: PairingReading): boolean => {
  const kinds = new Map(mailFactTypeVariables(spec).map((variable) => [variable.name, variable.kind]));
  return [...new Set(spec.identity.flat())].every((name) => {
    const x = a.variables[name] ?? null;
    const y = b.variables[name] ?? null;
    return MAIL_FACT_NAME_VARIABLES.has(name) || x === null || y === null
      || identityValueKey(x, kinds.get(name)) === identityValueKey(y, kinds.get(name));
  });
};

/** Two readings name the same thing by their ids: an identity that holds a
 *  name and an id, whose ids are read by both and agree — the names may be
 *  written differently, while one email's order number is the same order —
 *  and no other part of an identity they read disagrees. */
const sameIds = (spec: MailFactTypeSpec, a: PairingReading, b: PairingReading): boolean => {
  const kinds = new Map(mailFactTypeVariables(spec).map((variable) => [variable.name, variable.kind]));
  const agree = (name: string): boolean => {
    const x = a.variables[name] ?? null;
    const y = b.variables[name] ?? null;
    return x !== null && y !== null && identityValueKey(x, kinds.get(name)) === identityValueKey(y, kinds.get(name));
  };
  return partsAgree(spec, a, b) && spec.identity.some((alternative) => {
    const ids = alternative.filter((name) => kinds.get(name) !== 'text');
    return ids.length > 0 && ids.length < alternative.length && ids.every(agree);
  });
};

/** A fact or a reading with its identity keys. */
type KeyedReading = PairingReading & { readonly identity_keys: readonly string[] };

/** Whether a reading could be a fact read before, of its type and template:
 *  no key they hold whole differs and no part both read, and a key they
 *  share — or, where one has none, the same place (§5). */
const couldBeRead = (
  spec: MailFactTypeSpec,
  reading: PairingReading & { readonly position: number },
  keys: readonly string[],
  fact: StoredMailFact,
): boolean =>
  !identitiesDisagree(keys, fact.identity_keys) && partsAgree(spec, reading, fact)
  && (keys.some((key) => fact.identity_keys.includes(key))
    || ((keys.length === 0 || fact.identity_keys.length === 0) && fact.position === reading.position));

/** Each of `firsts` with the one of `seconds` it is, by the rule every
 *  matcher shares (`pairEach`, §4): every pair a key they share makes, where
 *  none disagrees, before any pair the same ids make — so a reading the ids
 *  alone would take is never taken from the fact whose key it shares — and
 *  the ids only where they name one pair. Firsts that are one another share a
 *  second: two blocks of one parcel both take the markup's reading of it,
 *  whichever came first. At the write, when the AI names the identity, and
 *  when a reading leaves as it was a fact that took one in. */
const matchOneToOne = <A extends KeyedReading, B extends KeyedReading>(
  spec: MailFactTypeSpec,
  firsts: readonly A[],
  seconds: readonly B[],
): Map<A, B> => {
  /** Not one another: a key they both have whole differs. */
  const apart = (a: KeyedReading, b: KeyedReading): boolean => identitiesDisagree(a.identity_keys, b.identity_keys);
  // A key pairs only what it names alone: readings it names that are not one
  // another — two invoices of one issuer and period, told apart by their
  // numbers — are neither the fact's, whichever the markup gave first; nor is
  // a reading the keys of two facts that are not one another both name.
  const matched = pairEach({
    readings: firsts,
    candidates: seconds,
    could: (a, b) => couldBeOne(a.identity_keys, b.identity_keys),
    readingsApart: apart,
    candidatesApart: apart,
    rank: (_reading, a, b) => byWhatItSays(a, b),
    readingRank: byWhatItSays,
    share: true,
  });
  // The ids alone pair only what they name alone: the one reading they name
  // for the fact, and no other fact for that reading. Two shops' orders of
  // one number are no match for a third shop's — §4 never guesses.
  const taken = new Set<B>(matched.values());
  const byIds = pairEach({
    readings: firsts.filter((first) => !matched.has(first)),
    candidates: seconds.filter((second) => !taken.has(second)),
    could: (a, b) => sameIds(spec, a, b),
    readingsApart: () => true,
    candidatesApart: () => true,
    rank: () => 0,
    readingRank: byWhatItSays,
    share: false,
  });
  for (const [first, second] of byIds) matched.set(first, second);
  return matched;
};

/** §7.1 — what the standards pass read into a fact, as a reading of its own:
 *  the values it gave, variables and data. */
const standardsReadingOf = (fact: StoredMailFact): RulesPassFact => {
  const variables: Record<string, MailFactValue | null> = {};
  const passes: Record<string, MailFactPass> = {};
  const data: Record<string, unknown> = {};
  for (const [name, pass] of Object.entries(fact.passes)) {
    if (pass !== 'standard') continue;
    if (name.startsWith('data.')) {
      const value = mailFactDataAt(fact.data, name.slice('data.'.length));
      if (value === undefined) continue;
      setPath(data, name.slice('data.'.length), structuredClone(value));
    } else {
      const value = fact.variables[name] ?? null;
      if (value === null) continue;
      variables[name] = value;
    }
    passes[name] = 'standard';
  }
  return { position: fact.position, variables, passes, data, refused: [], missing: [], complete: false };
};

/** §4 — pair one type's standards facts with its template's. */
export const mergeStandardsFacts = (
  spec: MailFactTypeSpec,
  template_id: string | null,
  templateFacts: readonly RulesPassFact[],
  standardsFacts: readonly RulesPassFact[],
): PlannedFact[] => {
  const tpl = templateFacts.map((fact) => ({
    fact,
    keys: identityKeysOf(spec, fact.variables),
    partner: undefined as RulesPassFact | undefined,
  }));
  const std = standardsFacts.map((fact) => ({ fact, keys: identityKeysOf(spec, fact.variables), used: false }));
  // 1. The same identity key — unless another key disagrees: two invoices of
  //    one issuer and period share the period and are two invoices — or the
  //    same ids, whose names may be written differently. One each.
  const matches = matchOneToOne(
    spec,
    tpl.map((t) => ({ t, identity_keys: t.keys, variables: t.fact.variables })),
    std.map((s) => ({ s, identity_keys: s.keys, variables: s.fact.variables })),
  );
  for (const [{ t }, { s }] of matches) {
    s.used = true;
    t.partner = s.fact;
  }
  // 2. Each pass found exactly one, and their identities do not disagree.
  const onlyTemplate = tpl.length === 1 ? tpl[0]! : undefined;
  const onlyStandard = std.length === 1 ? std[0]! : undefined;
  if (onlyTemplate !== undefined && onlyStandard !== undefined && onlyTemplate.partner === undefined && !onlyStandard.used) {
    // Every part both read — not only the keys either has whole: a template
    // that read the invoice number and not the issuer has no key.
    const disagree = identitiesDisagree(onlyTemplate.keys, onlyStandard.keys)
      || !partsAgree(spec, onlyTemplate.fact, onlyStandard.fact)
      || (onlyTemplate.keys.length > 0
        && onlyStandard.keys.length > 0
        && !onlyTemplate.keys.some((key) => onlyStandard.keys.includes(key)));
    if (!disagree) {
      onlyStandard.used = true;
      onlyTemplate.partner = onlyStandard.fact;
    }
  }
  const planned: PlannedFact[] = tpl.map((t) => ({
    spec,
    template_id,
    read: t.partner === undefined ? t.fact : combineFacts(spec, t.fact, t.partner),
    unpaired: false,
    partnered: t.partner !== undefined,
  }));
  // 3. What is left: its own thing, unless a template fact that read no
  //    identity is left too and might be that very thing.
  const ambiguous = tpl.some((t) => t.partner === undefined && t.keys.length === 0);
  for (const s of std) {
    if (!s.used) planned.push({ spec, template_id: null, read: s.fact, unpaired: ambiguous, partnered: false });
  }
  return planned;
};

const thingRecord = (thing: MailFactThing): Record<string, unknown> => ({
  ...thing.variables,
  _id: thing.thing_id,
  _collection: MAIL_FACT_EVENT_PLATFORM,
  thing_id: thing.thing_id,
  type: thing.type,
  identity_keys: thing.identity_keys,
  complete: thing.complete,
  missing: thing.missing,
  last_email_at: thing.last_email_at,
  passes: thing.passes,
});

/** The event's `record` (§5): the thing's variables at the top level, then the
 *  fact that caused the change, with its data. */
export const mailFactTriggerRecord = (thing: MailFactThing, fact: MailFact): MailFactTriggerRecord => ({
  ...thingRecord(thing),
  _id: thing.thing_id,
  _collection: MAIL_FACT_EVENT_PLATFORM,
  thing_id: thing.thing_id,
  type: thing.type,
  identity_keys: thing.identity_keys,
  complete: thing.complete,
  missing: thing.missing,
  last_email_at: thing.last_email_at,
  template: fact.template_id,
  passes: thing.passes,
  fact: {
    fact_id: fact.fact_id,
    email: fact.email,
    email_at: fact.email_at,
    template_id: fact.template_id,
    data: fact.data,
    passes: fact.passes,
  },
});

/** A thing as its facts fold it. */
const thingOf = (
  thing_id: string,
  spec: MailFactTypeSpec,
  facts: readonly MailFact[],
  folded: FoldedThing,
  created_at: number,
  updated_at: number,
): MailFactThing => ({
  thing_id,
  type: spec.id,
  identity_keys: [...new Set(facts.flatMap((fact) => fact.identity_keys))],
  variables: folded.variables,
  passes: folded.passes,
  variable_email_at: folded.variable_email_at,
  last_email_at: folded.last_email_at,
  missing: folded.missing,
  complete: folded.complete,
  created_at,
  updated_at,
});

export const createMailFactWriter = (deps: MailFactWriterDeps): MailFactWriter => {
  const { store } = deps;
  const isSecurityNotice = deps.isSecurityNotice ?? looksLikeSecurityNotice;
  const changed = (what: MailFactChange): void => {
    try {
      deps.onChanged?.(what);
    } catch (error) {
      deps.logger?.warn('mail fact: a change could not be announced', { error });
    }
  };

  const aiWasQueued = (): void => {
    try {
      deps.onAiQueued?.();
    } catch (error) {
      deps.logger?.warn('mail fact: the AI pass could not be started', { error });
    }
  };

  // After the commit, at most once: a failed delivery never undoes the facts
  // (the precedent of form-response-events.ts).
  const emitAll = (events: readonly WarehouseEvent[]): void => {
    for (const event of events) {
      try {
        deps.emit(event);
      } catch (error) {
        deps.logger?.warn('mail fact: an event could not be emitted', { error, record_id: event.record_id });
      }
    }
  };

  /** Re-fold one thing from its facts and save it; it goes when it has none left. */
  const refold = (thing_id: string, spec: MailFactTypeSpec, at: number): {
    readonly after: MailFactThing | null;
    readonly folded: FoldedThing | null;
    readonly facts: readonly StoredMailFact[];
  } => {
    const before = store.getThing(thing_id);
    const facts = store.factRecordsForThing(thing_id);
    if (facts.length === 0) {
      if (before !== null) store.deleteThing(thing_id);
      return { after: null, folded: null, facts };
    }
    const folded = foldThing(spec, facts);
    const after = thingOf(thing_id, spec, facts, folded, before?.created_at ?? at, at);
    store.saveThing(after);
    return { after, folded, facts };
  };

  /** Facts that go, and their things re-folded silently — settled first: a
   *  fact two things could both be, one of them gone, is the other's (§5). */
  const dropFacts = (facts: readonly MailFact[], at: number): void => {
    if (facts.length === 0) return;
    const placement = createPlacement();
    for (const fact of facts) {
      const spec = typeSpecOf(store, fact.type);
      if (spec !== undefined && fact.thing_id !== null) placement.touch(fact.thing_id, spec);
    }
    store.deleteFacts(facts.map((fact) => fact.fact_id));
    placement.fold(at, undefined);
  };

  /** One email's facts, placed on their things inside the caller's
   *  transaction; `fold` re-folds every affected thing and returns the events
   *  its news makes (§5). */
  const createPlacement = () => {
    const affected = new Map<string, MailFactTypeSpec>();
    const news = new Map<string, Set<string>>(); // thing → this email's news on it
    const newsFacts = new Map<string, MailFact>();
    // A fact whose news came another way than this reading's: a queued
    // call's, which keeps the origin it came with.
    const newsOrigin = new Map<string, 'live' | 'backfill'>();
    // This email's facts placed so far, which the key index does not show
    // until their thing is folded: per type, every thing that holds a key —
    // two blocks can each hold it and disagree — and every key a thing holds.
    const localHolders = new Map<string, Map<string, Set<string>>>();
    const localThingKeys = new Map<string, Set<string>>();
    const holdersOf = (type: string): Map<string, Set<string>> => {
      const holders = localHolders.get(type) ?? new Map<string, Set<string>>();
      localHolders.set(type, holders);
      return holders;
    };
    const hold = (type: string, key: string, thing_id: string): void => {
      const holders = holdersOf(type);
      holders.set(key, (holders.get(key) ?? new Set<string>()).add(thing_id));
      localThingKeys.set(thing_id, (localThingKeys.get(thing_id) ?? new Set<string>()).add(key));
    };
    const keysOf = (_type: string, thing_id: string): string[] => [...new Set([
      ...(store.getThing(thing_id)?.identity_keys ?? []),
      ...(localThingKeys.get(thing_id) ?? []),
    ])];
    const bornAt = (thing_id: string): number => store.getThing(thing_id)?.created_at ?? Number.POSITIVE_INFINITY;
    /** Per type, the keys a fact placed here, or taken off a thing, held:
     *  around them, the things are settled at the fold. */
    const seeds = new Map<string, { readonly spec: MailFactTypeSpec; readonly keys: Set<string> }>();
    const seed = (spec: MailFactTypeSpec, keys: Iterable<string>): void => {
      const entry = seeds.get(spec.id) ?? { spec, keys: new Set<string>() };
      for (const key of keys) entry.keys.add(key);
      seeds.set(spec.id, entry);
    };
    /** `from` was `to` all along (§3.1): its facts, runs and news move over,
     *  and its keys: the index drops them with `from`, and a later block of
     *  this email that names only one of them must find `to`. */
    const merge = (type: string, from: string, to: string): void => {
      const carried = keysOf(type, from);
      store.mergeThings(from, to);
      const spec = affected.get(from);
      affected.delete(from);
      if (spec !== undefined) affected.set(to, spec);
      const moved = news.get(from);
      if (moved !== undefined) {
        news.delete(from);
        const into = news.get(to) ?? new Set<string>();
        for (const id of moved) into.add(id);
        news.set(to, into);
      }
      const holders = holdersOf(type);
      for (const key of carried) {
        holders.get(key)?.delete(from);
        hold(type, key, to);
      }
      localThingKeys.delete(from);
    };
    /** One fact onto another thing: its news goes with it. */
    const move = (fact: StoredMailFact, spec: MailFactTypeSpec, to: string): void => {
      const from = fact.thing_id!;
      store.updateFact({ ...fact, thing_id: to });
      affected.set(from, spec);
      affected.set(to, spec);
      const held = news.get(from);
      if (held?.delete(fact.fact_id) === true) {
        if (held.size === 0) news.delete(from);
        news.set(to, (news.get(to) ?? new Set<string>()).add(fact.fact_id));
      }
      for (const key of fact.identity_keys) hold(spec.id, key, to);
    };
    /** §5 — the facts around `keys`, on things as the set of them says,
     *  whatever order they came in (`thingGroups`): placed one by one, a
     *  refund naming only its order joined the first return it met when it
     *  came first, and neither when it came last. A group keeps the oldest
     *  thing its facts are on that no group decided before it kept — a group
     *  that is decided first — and a fact with no key stays where it is. */
    const settle = (spec: MailFactTypeSpec, keys: ReadonlySet<string>): void => {
      const region = new Map<string, StoredMailFact>();
      const things = new Set<string>();
      const seen = new Set<string>();
      let frontier = [...keys];
      while (frontier.length > 0) {
        for (const key of frontier) seen.add(key);
        const named = new Set([
          ...frontier.flatMap((key) => [...(holdersOf(spec.id).get(key) ?? [])]),
          ...store.thingIdsByKeys(spec.id, frontier),
        ]);
        const next = new Set<string>();
        for (const thing_id of named) {
          if (things.has(thing_id)) continue;
          things.add(thing_id);
          for (const fact of store.factRecordsForThing(thing_id)) {
            region.set(fact.fact_id, fact);
            for (const key of fact.identity_keys) if (!seen.has(key)) next.add(key);
          }
        }
        // Past this many, what was placed stands: a region this wide is no
        // one thing's, and each write would read it whole.
        if (region.size > MAIL_FACT_SETTLE_MAX_FACTS) return;
        frontier = [...next];
      }
      const keyed = [...region.values()].filter((fact) => fact.identity_keys.length > 0);
      const groups = thingGroups(keyed).map((group) => ({
        ...group,
        on: [...new Set(group.members.map((fact) => fact.thing_id!))]
          .sort((a, b) => bornAt(a) - bornAt(b) || (a < b ? -1 : 1)),
      })).sort((a, b) => Number(a.undecided) - Number(b.undecided)
        || bornAt(a.on[0]!) - bornAt(b.on[0]!)
        || (a.on[0]! < b.on[0]! ? -1 : a.on[0]! > b.on[0]! ? 1 : 0));
      const kept = new Set<string>();
      const targetOf = new Map<string, string>();
      for (const group of groups) {
        const to = group.on.find((thing_id) => !kept.has(thing_id)) ?? store.mintId('mthing');
        kept.add(to);
        for (const fact of group.members) targetOf.set(fact.fact_id, to);
      }
      const onThing = new Map<string, StoredMailFact[]>();
      for (const fact of region.values()) onThing.set(fact.thing_id!, [...(onThing.get(fact.thing_id!) ?? []), fact]);
      for (const [thing_id, facts] of onThing) {
        const targets = new Set(facts.flatMap((fact) => {
          const to = targetOf.get(fact.fact_id);
          return to === undefined ? [] : [to];
        }));
        // A thing wholly another's is merged into it: its runs, and a fact
        // waiting to come back to it, go along.
        if (!kept.has(thing_id) && targets.size === 1) {
          const [to] = targets as Set<string>;
          merge(spec.id, thing_id, to!);
          affected.set(to!, spec);
          continue;
        }
        for (const fact of facts) {
          const to = targetOf.get(fact.fact_id);
          if (to !== undefined && to !== thing_id) move(fact, spec, to);
        }
      }
    };
    return {
      /** The thing sharing any of the keys whose identity does not disagree,
       *  or the thing the fact was on before (`prior`), or a new one. A fact
       *  that names two things that do not disagree makes them one: the
       *  older stays. */
      thingFor: (spec: MailFactTypeSpec, identityKeys: readonly string[], prior: string | null = null): string => {
        const holders = holdersOf(spec.id);
        const named = [...new Set([
          ...identityKeys.flatMap((key) => [...(holders.get(key) ?? [])]),
          ...store.thingIdsByKeys(spec.id, identityKeys),
        ])].sort((a, b) => bornAt(a) - bornAt(b) || (a < b ? -1 : 1));
        const fitting = named.filter((id) => !identitiesDisagree(identityKeys, keysOf(spec.id, id)));
        // A thing that could as well be one this fact is not — sharing a key
        // with it, and disagreeing with it in nothing — is not this fact's to
        // take: a refund naming only its order could be either return's.
        const others = named.filter((id) => !fitting.includes(id));
        const own = fitting.filter((id) => !others.some((other) => couldBeOne(keysOf(spec.id, id), keysOf(spec.id, other))));
        // Things it could be that are not one another — two returns of one
        // order — are settled at the fold, with what came after it: it is
        // neither's (`settle`). Here it takes the oldest.
        const thing_id = own[0]
          ?? (prior !== null && !identitiesDisagree(identityKeys, keysOf(spec.id, prior)) ? prior : store.mintId('mthing'));
        for (const other of own.slice(1)) {
          if (other !== thing_id && !identitiesDisagree(keysOf(spec.id, thing_id), keysOf(spec.id, other))) {
            merge(spec.id, other, thing_id);
          }
        }
        for (const key of identityKeys) hold(spec.id, key, thing_id);
        return thing_id;
      },
      /** A fact of this email now on its thing; `isNews` when its change is
       *  news a subscriber has not heard. */
      placed: (fact: MailFact, spec: MailFactTypeSpec, isNews: boolean, origin?: 'live' | 'backfill'): void => {
        affected.set(fact.thing_id!, spec);
        seed(spec, fact.identity_keys);
        if (!isNews) return;
        newsFacts.set(fact.fact_id, fact);
        if (origin !== undefined) newsOrigin.set(fact.fact_id, origin);
        const set = news.get(fact.thing_id!) ?? new Set<string>();
        set.add(fact.fact_id);
        news.set(fact.thing_id!, set);
      },
      /** A thing that lost a fact: it re-folds silently. */
      touch: (thing_id: string, spec: MailFactTypeSpec): void => {
        if (!affected.has(thing_id)) affected.set(thing_id, spec);
        seed(spec, keysOf(spec.id, thing_id));
      },
      fold: (at: number, origin: 'backfill' | undefined): WarehouseEvent[] => {
        for (const { spec, keys } of seeds.values()) settle(spec, keys);
        const events: WarehouseEvent[] = [];
        for (const [thing_id, spec] of affected) {
          const { after, folded, facts } = refold(thing_id, spec, at);
          const ids = news.get(thing_id);
          if (after === null || folded === null || ids === undefined) continue;
          // Live news makes the event live: a live email stays live whoever
          // reads it again.
          const live = [...ids].some((id) => (newsOrigin.get(id) ?? (origin === 'backfill' ? 'backfill' : 'live')) === 'live');
          // Against what a subscriber knew. Live news: the thing without it —
          // past mail stored silently is what the thing was. A replay of past
          // mail (a backfill that runs recipes, oldest first): only what was
          // told before it; the later mail it has not told yet is no part of
          // what a subscriber knew, and would hide every change but the last.
          const others = live
            ? facts.filter((fact) => !ids.has(fact.fact_id))
            : facts.filter((fact) => fact.announced && !ids.has(fact.fact_id));
          const shown = live ? facts : [...others, ...facts.filter((fact) => ids.has(fact.fact_id))];
          const before = others.length === 0 ? null : foldThing(spec, others);
          const now = live ? folded : foldThing(spec, shown);
          const change = diffThing(spec, before, now, ids);
          if (change === null) continue;
          // The fact the record carries: the newest of this email's news on the thing.
          const cause = [...ids].map((id) => newsFacts.get(id)!).sort((a, b) => b.position - a.position)[0]!;
          const told = live ? after : thingOf(thing_id, spec, shown, now, after.created_at, after.updated_at);
          events.push({
            platform: MAIL_FACT_EVENT_PLATFORM,
            slug: spec.id,
            entity_type: MAIL_FACT_EVENT_ENTITY_TYPE,
            event_kind: change.kind,
            record_id: thing_id,
            at: cause.email_at,
            record: { ...mailFactTriggerRecord(told, cause) },
            ...(before !== null ? { prev: thingRecord(thingOf(thing_id, spec, others, before, after.created_at, after.updated_at)) } : {}),
            changed_fields: [...change.changed_fields],
            ...(live ? {} : { origin: 'backfill' as const }),
          });
        }
        return events;
      },
    };
  };

  const write = (input: MailFactWriteInput): MailFactWriteResult => {
    const at = deps.now();
    const labels = labelsOf(input.email);
    const templates = store.listTemplates({ active: true });
    const ledger = store.getEmailLedger(input.ref);
    // Read already, and nothing it was read from moved (ruling 13).
    if (
      input.force !== true
      && ledger !== null
      && ledger.fingerprint === input.content_fingerprint
      && !ledger.news
      && !testedLabelsMoved(templates, ledger.labels, labels)
    ) {
      return { skipped: 'unchanged', facts: store.factsForEmail(input.ref).length, events: 0 };
    }
    // §5, ruling 13 — the same copy found again under another id (an IMAP
    // folder whose ids were reset) was read already: its first reading carried
    // the news. A copy in another place is its own. A backfill says for itself.
    const copyKey = mailFactCopyKey(input.email, input.envelope);
    // The same email, where it was first read: the copy takes its date and
    // its place among mail of that date, or a copy of an old transit notice
    // read after the delivery would be the newest word on the parcel.
    const original = input.force !== true && copyKey !== null && ledger?.fingerprint == null
      ? store.emailCopyOf(input.ref.slug, copyKey, input.ref.record_id)
      : null;
    const copy = original !== null;
    const news = !copy && (input.may_trigger || ledger?.news === true);
    // Health counts each email once per template revision (§6.2).
    const counted = new Set(ledger?.counted ?? []);
    const ledgerRead = (skipped: 'security_notice' | null, email_at: number) => {
      const templateIds = new Set(store.listTemplates().map((template) => template.template_id));
      return {
        email: input.ref,
        fingerprint: input.content_fingerprint,
        labels,
        read_at: at,
        news: false,
        skipped,
        counted: [...counted].filter((mark) => templateIds.has(mark.slice(0, mark.lastIndexOf('@')))),
        copy_key: copyKey,
        email_at,
        ...(original?.arrival != null ? { arrival: original.arrival } : {}),
      };
    };

    // The owner's own request is never a security notice, whatever it says.
    const ownRequest = input.envelope !== undefined && recognizeOwnerRequest(input.email, input.envelope) !== null;
    if (!ownRequest && isSecurityNotice(input.email)) {
      deps.logger?.warn('mail fact: skipped a security notice', { email: input.ref });
      const dropped = store.transaction(() => {
        const facts = store.factsForEmail(input.ref);
        store.deleteAiJobsForEmails(input.ref.slug, [input.ref.record_id]);
        dropFacts(facts, at);
        store.saveEmailLedger(ledgerRead('security_notice', ledger?.email_at ?? input.email_at));
        return facts.length;
      });
      if (dropped > 0) changed('facts');
      return { skipped: 'security_notice', facts: 0, events: 0 };
    }

    const standardsOff = store.standardsOff();
    let healthMoved = false;
    // Mail the account sent is read only by a template that asks for it — one
    // whose entrance names a label or folder (the Sent one) — and for owner
    // requests (§7.4). A shipping number the owner mails a buyer is not a
    // parcel coming to them.
    const sent = input.envelope !== undefined && readAsSent(input.envelope);
    // Per type, the most specific template that meets its entrance wins.
    const byType = new Map<string, MailTemplate[]>();
    for (const template of templates) {
      if (sent && !template.entrance.conditions.some((condition) => condition.field === 'label' && condition.negate !== true)) continue;
      const list = byType.get(template.type) ?? [];
      list.push(template);
      byType.set(template.type, list);
    }
    const winners: { template: MailTemplate; spec: MailFactTypeSpec; facts: readonly RulesPassFact[] }[] = [];
    for (const [type, list] of byType) {
      const spec = typeSpecOf(store, type);
      if (spec === undefined) continue;
      const ordered = [...list].sort(
        (a, b) =>
          templateSpecificity(b.entrance.conditions) - templateSpecificity(a.entrance.conditions)
          || a.created_at - b.created_at
          || (a.template_id < b.template_id ? -1 : 1),
      );
      for (const template of ordered) {
        const outcome = runRulesPass(template, spec, input.email);
        // A backfill counts only the template it reads for: the others read
        // these emails already, and counting them again would skew their
        // health. And no revision counts one email twice.
        const mark = `${template.template_id}@${template.revision}`;
        if (
          input.count_health
          && (input.backfill_template === undefined || input.backfill_template === template.template_id)
          && !counted.has(mark)
        ) {
          counted.add(mark);
          store.recordTemplateOutcome(
            template.template_id,
            outcome.kind === 'facts' ? 'entered' : outcome.kind,
            at,
            outcome.warnings,
          );
          if (outcome.kind !== 'no_match' || (outcome.warnings?.length ?? 0) > 0) healthMoved = true;
        }
        if (outcome.kind === 'facts') {
          winners.push({ template, spec, facts: outcome.facts });
          break;
        }
      }
    }

    // The standards pass reads every email; §4 pairs its facts with the templates'.
    const standards: StandardsFact[] = runStandardsPass(input.email, input.envelope ?? null, {
      isOn: (type) => !standardsOff.has(type),
    });
    const planned: PlannedFact[] = [];
    const types = new Set<string>([...winners.map((winner) => winner.spec.id), ...standards.map((fact) => fact.type)]);
    for (const type of types) {
      const winner = winners.find((w) => w.spec.id === type);
      const spec = winner?.spec ?? typeSpecOf(store, type);
      if (spec === undefined) continue;
      planned.push(...mergeStandardsFacts(
        spec,
        winner?.template.template_id ?? null,
        winner?.facts ?? [],
        standards.filter((fact) => fact.type === type),
      ));
    }

    const events: WarehouseEvent[] = [];
    let factCount = 0;
    let aiQueued = false;
    let touchedAny = false;
    store.transaction(() => {
      const existing = store.factRecordsForEmail(input.ref);
      // §5 — the date its facts are ordered by, fixed when it was first read:
      // read again later (a backfill), a future-dated email would otherwise be
      // dated then, and pass mail that came since — a delivered parcel back
      // "in transit". Read before the date was kept, the date its facts have.
      const emailAt = mailFactEmailDate(store, input.ref, original?.email_at ?? input.email_at);
      touchedAny = existing.length > 0;
      // What this reading may replace: facts of the templates that are on and
      // of the standards types that are on. A fact of a template switched off
      // or deleted, or of a standards type switched off, stays with its email.
      const activeIds = new Set(templates.map((template) => template.template_id));
      const replaceable = (fact: StoredMailFact): boolean =>
        fact.template_id !== null ? activeIds.has(fact.template_id) : !standardsOff.has(fact.type);
      const unmatched = new Set<StoredMailFact>(existing.filter(replaceable));
      const kept = existing.filter((fact) => !replaceable(fact));
      /** The fact this one replaces: the same type and template, and the same
       *  identity — or, where one of them has none, the same place. A key they
       *  share is not enough when another disagrees: two returns of one order
       *  share the order and are two facts, and one must not take the other's
       *  id, or its announcement. Nor is the same place, when a part of an
       *  identity both read differs: order B-9 read where A-123 was, its
       *  merchant unread, is another order — taken for A-123, it took A-123's
       *  id, and what the pass had read for it (§7.1). */
      // By the rule every matcher shares (`pairEach`): a prior fact two that
      // are not one another could both be is neither's — a refund naming
      // only its order, beside two returns of it — and a reading two such
      // could both replace replaces neither, whichever the store gave first.
      // Of the priors it could be that are one another, the one in its place.
      const predecessors = new Map<string, Map<PlannedFact, StoredMailFact>>();
      const predecessorOf = (plan: PlannedFact): StoredMailFact | undefined => {
        const group = `${plan.spec.id}\u0000${plan.template_id ?? ''}`;
        let pairing = predecessors.get(group);
        if (pairing === undefined) {
          const keysOfPlan = new Map(planned.map((other) => [other, identityKeysOf(other.spec, other.read.variables)]));
          // Every reading of the group, one a kept or held fact took in too:
          // it replaces nothing, and a fact it could be is no other's.
          const plans = planned.filter((other) => other.spec.id === plan.spec.id && other.template_id === plan.template_id);
          pairing = pairEach({
            readings: plans,
            candidates: [...unmatched].filter((fact) => fact.type === plan.spec.id && fact.template_id === plan.template_id),
            could: (reading, fact) => couldBeRead(reading.spec, reading.read, keysOfPlan.get(reading)!, fact),
            readingsApart: (a, b) => identitiesDisagree(keysOfPlan.get(a)!, keysOfPlan.get(b)!),
            candidatesApart: (a, b) => identitiesDisagree(a.identity_keys, b.identity_keys),
            rank: (reading, a, b) => Number(b.position === reading.read.position) - Number(a.position === reading.read.position)
              || a.position - b.position,
            readingRank: (a, b) => a.read.position - b.read.position,
            share: false,
          });
          predecessors.set(group, pairing);
        }
        const found = pairing.get(plan);
        if (found !== undefined) unmatched.delete(found);
        return found;
      };
      const placement = createPlacement();
      // Per template: whether a fact waiting on its AI is news once placed.
      const waitingOn = new Map<string, boolean>();
      // §4.3 — news the email's queued calls hold, per template, with the
      // origin it came with. A fact that waited on a call was news when it was
      // read; read now without the call — the rules came to read what it
      // would have — it is news still, and the job goes.
      const heldNews = new Map<string, 'live' | 'backfill'>();
      for (const job of store.aiJobsForEmail(input.ref)) {
        if (job.may_trigger) heldNews.set(job.template_id, job.origin ?? 'live');
      }
      /** Per type: each template fact this reading leaves as it was, the AI's
       *  answers included, whose reading here took no standards reading in.
       *  The template facts come first. */
      const heldFacts = new Map<string, StoredMailFact[]>();
      /** Per type: the standards readings a kept fact or a held one took in
       *  when it was read — one each, as the pairing takes them. Asked once
       *  the type's template facts are through. */
      const absorbed = new Map<string, ReadonlySet<PlannedFact>>();
      const absorbedBy = (spec: MailFactTypeSpec): ReadonlySet<PlannedFact> => {
        const known = absorbed.get(spec.id);
        if (known !== undefined) return known;
        const holders = [...kept.filter((fact) => fact.type === spec.id), ...(heldFacts.get(spec.id) ?? [])];
        const readings = planned
          .filter((candidate) => candidate.template_id === null && candidate.spec.id === spec.id)
          .map((candidate) => ({ plan: candidate, identity_keys: identityKeysOf(spec, candidate.read.variables), variables: candidate.read.variables }));
        const taken = new Set([...matchOneToOne(spec, holders, readings).values()].map((reading) => reading.plan));
        absorbed.set(spec.id, taken);
        return taken;
      };

      for (const plan of planned) {
        const { spec, template_id, read, unpaired } = plan;
        const identityKeys = identityKeysOf(spec, read.variables);
        // A kept fact of the same thing took in the standards pass's reading
        // when it was read: the pass alone adds no second one beside it. So
        // did a template fact this reading leaves as it was, whose identity the
        // AI filled and which joined the pass's fact then. One reading each, as
        // the pairing takes them — never every reading one of them could take.
        if (template_id === null && absorbedBy(spec).has(plan)) continue;
        const prior = predecessorOf(plan);
        const template = template_id === null ? undefined : templates.find((t) => t.template_id === template_id);
        // §7.1 — read while the standards pass was off for the kind, a fact is
        // read anew once it is on: what the pass adds was never read. Switched
        // off, it takes nothing back: a fact read while it was on stays.
        const offNow = standardsOff.has(spec.id);
        const source_hash = factSourceHash(input.content_fingerprint, template, spec, offNow);
        const unchanged = prior !== undefined && (prior.source_hash === source_hash
          || (offNow && prior.source_hash === factSourceHash(input.content_fingerprint, template, spec, false)));
        // News a subscriber has not heard: a backfill announces only the facts
        // of the template it reads for — and a queued call's news, which was
        // there before it. A markup fact kept unpaired waited on the identity a
        // live call would name, and has that call's news (as `applyAi` gives it).
        const ownNews = news && (input.backfill_template === undefined || template_id === input.backfill_template);
        const held = template_id !== null
          ? heldNews.get(template_id)
          : prior !== undefined && prior.thing_id === null && !prior.announced
              && templates.some((t) => t.type === spec.id && heldNews.get(t.template_id) === 'live')
            ? 'live' as const
            : undefined;
        const mayAnnounce = (ownNews || held !== undefined) && prior?.announced !== true;
        const newsOrigin = held === 'live' || (ownNews && input.origin === undefined) ? 'live' as const : 'backfill' as const;

        // A markup fact kept unpaired waited on the identity the template's
        // reading would name. That reading names it now — the rules came to
        // read it — and nothing else will place the fact: its call goes.
        const unstranded = template_id === null && prior !== undefined && prior.thing_id === null && !unpaired;
        if (prior !== undefined && unchanged && !unstranded) {
          // Its reading here took a standards reading in already: it holds that one.
          if (template_id !== null && prior.identity_keys.length > 0 && !plan.partnered) {
            heldFacts.set(spec.id, [...(heldFacts.get(spec.id) ?? []), prior]);
          }
          // Nothing it was read from changed: it stays as it was, the AI's
          // answers included. Stored silently, it is announced now when this
          // reading is news.
          if (!mayAnnounce) continue;
          if (prior.ai?.state === 'waiting') {
            if (template_id !== null) store.promoteAiJob(input.ref, template_id, input.origin ?? null);
            continue;
          }
          if (prior.thing_id === null) continue;
          const announced: StoredMailFact = { ...prior, announced: true };
          store.updateFact(announced);
          placement.placed(announced, spec, true, newsOrigin);
          continue;
        }

        // Switched off, the pass takes nothing back from a template's fact read
        // anew — its rules edited since: what the pass read while it was on
        // fills what the rules leave, the owner's rule first, as it did then.
        // (Rules that now name another thing replace no fact, and keep nothing.)
        const reading = offNow && prior !== undefined ? combineFacts(spec, read, standardsReadingOf(prior)) : read;
        const keys = reading === read ? identityKeys : identityKeysOf(spec, reading.variables);
        const waits = !unpaired
          && template !== undefined
          && template.ai.enabled
          && mailFactEmptyAiSlots(template.ai.slots, reading).length > 0;
        const priorThing = prior?.thing_id ?? prior?.prior_thing_id ?? null;
        const thing_id = unpaired || waits ? null : placement.thingFor(spec, keys, priorThing);
        const announce = !waits && thing_id !== null && mayAnnounce;
        const fact: StoredMailFact = {
          fact_id: prior?.fact_id ?? store.mintId('mfact'),
          type: spec.id,
          template_id,
          email: input.ref,
          email_at: emailAt,
          position: reading.position,
          identity_keys: keys,
          thing_id,
          variables: reading.variables,
          passes: reading.passes,
          data: reading.data,
          missing: reading.missing,
          refused: reading.refused,
          complete: reading.complete,
          source_hash,
          revision: prior === undefined ? 1 : sameReading(prior, reading) ? prior.revision : prior.revision + 1,
          created_at: prior?.created_at ?? at,
          ...(waits ? { ai: { state: 'waiting' as const, since: at } } : {}),
          template_revision: template?.revision ?? null,
          announced: (prior?.announced ?? false) || announce,
          // A re-read that waits for the AI returns to its thing after.
          prior_thing_id: waits ? priorThing : null,
        };
        if (prior === undefined || !sameReading(prior, reading)) factCount += 1;
        if (prior === undefined) store.insertFact(fact);
        else {
          store.updateFact(fact);
          if (prior.thing_id !== null && prior.thing_id !== thing_id) placement.touch(prior.thing_id, spec);
        }
        if (waits) waitingOn.set(template_id!, (waitingOn.get(template_id!) ?? false) || mayAnnounce);
        else if (thing_id !== null) placement.placed(fact, spec, announce, newsOrigin);
      }

      // A fact this reading no longer yields goes (§5); its thing re-folds silently.
      for (const gone of unmatched) {
        const spec = typeSpecOf(store, gone.type);
        if (spec !== undefined && gone.thing_id !== null) placement.touch(gone.thing_id, spec);
      }
      store.deleteFacts([...unmatched].map((fact) => fact.fact_id));

      // The AI pass (§4.3): a job for each template a new reading waits on; one
      // nothing waits on any more goes. Queued again, news it carried stays news.
      for (const [template_id, mayTrigger] of waitingOn) {
        store.enqueueAiJob({
          job_id: store.mintId('maijob'),
          email: input.ref,
          template_id,
          may_trigger: mayTrigger,
          ...(input.origin !== undefined ? { origin: input.origin } : {}),
          attempts: 0,
          queued_at: at,
        });
        aiQueued = true;
      }
      const stillWaiting = new Set(store.factRecordsForEmail(input.ref)
        .filter((fact) => fact.ai?.state === 'waiting')
        .map((fact) => fact.template_id));
      for (const job of store.aiJobsForEmail(input.ref)) {
        if (!stillWaiting.has(job.template_id)) store.deleteAiJobFor(input.ref, job.template_id);
      }

      store.saveEmailLedger(ledgerRead(null, emailAt));
      events.push(...placement.fold(at, input.origin));
    });

    emitAll(events);
    if (touchedAny || factCount > 0) changed('facts');
    if (healthMoved) changed('templates');
    if (aiQueued) aiWasQueued();
    return { facts: factCount, events: events.length };
  };

  const applyAi = (job: MailFactAiJob, readings: readonly MailFactAiReading[]): MailFactWriteResult => {
    const at = deps.now();
    const events: WarehouseEvent[] = [];
    let placed = 0;
    store.transaction(() => {
      // As it is stored now, not as the runner read it: queued again since, a
      // newer reading of the email asked its own call; promoted since (a
      // backfill that runs recipes reached the email), it carries news.
      const stored = store.getAiJob(job.job_id);
      if (stored === null) return;
      store.deleteAiJob(job.job_id);
      // A template deleted or switched off meanwhile starts nothing: its facts
      // are placed silently.
      const template = store.getTemplate(job.template_id);
      const live = template !== null && template.active;
      // What its AI may fill now; `null` when its AI is off.
      const aiSlots = template?.ai.enabled === true ? template.ai.slots : null;
      const placement = createPlacement();
      // By id, not by email: an email moved during the call keeps its facts.
      const answered: {
        fact: StoredMailFact;
        spec: MailFactTypeSpec;
        reading: MailFactAiReading['reading'];
        ai: MailFactAiReading['ai'];
      }[] = [];
      for (const { fact_id, reading, ai } of readings) {
        const fact = store.getFactRecord(fact_id);
        if (fact === null || fact.ai?.state !== 'waiting') continue;
        const spec = typeSpecOf(store, fact.type);
        if (spec === undefined) {
          store.updateFact({ ...fact, ai });
          continue;
        }
        // Switched off or deleted while the call ran: it reads no mail, so the
        // AI's answer is not taken — the fact settles on what the rules read
        // (§4.3), as it does when the template is off before the call. So when
        // its AI was switched off, or a slot it filled taken from it: the
        // owner said since what the AI may fill, and whoever settles the call,
        // the answer is read as the template is now.
        const notTaken = template === null ? 'its template was deleted'
          : !template.active ? 'its template was switched off'
          : ai.state !== 'read' ? null
          : aiSlots === null ? "its template's AI was switched off"
          : ai.filled.some((slot) => !aiSlots.includes(slot)) ? "its template's AI may no longer fill what it answered"
          : null;
        if (notTaken !== null) {
          answered.push({
            fact,
            spec,
            reading: {
              variables: fact.variables,
              passes: fact.passes,
              data: fact.data as Readonly<Record<string, unknown>> | null,
              refused: fact.refused,
              missing: fact.missing,
              complete: fact.complete,
            },
            ai: { state: 'not_read', reason: notTaken, at },
          });
          continue;
        }
        answered.push({ fact, spec, reading, ai });
      }
      // §4 — a standards fact kept UNPAIRED waited on the identity the AI just
      // filled: it was left apart only because a template fact read none. Now
      // it joins the fact it names, the owner's rule winning, or is its own.
      const alone: { fact: StoredMailFact; spec: MailFactTypeSpec }[] = [];
      for (const type of new Set(answered.map((entry) => entry.fact.type))) {
        const mine = answered.filter((entry) => entry.fact.type === type);
        const spec = mine[0]!.spec;
        const onEmail = store.factRecordsForEmail(mine[0]!.fact.email).filter((fact) => fact.type === type);
        const unpaired = onEmail.filter((fact) => fact.template_id === null && fact.thing_id === null && fact.ai === undefined);
        if (unpaired.length === 0) continue;
        // The joins the answers prove come first, one each, as at write: a
        // shared key where no other disagrees — two invoices of one issuer
        // and period share the period — or the same ids. A parcel the AI
        // named takes its markup though another it could not name is waiting.
        const proven = matchOneToOne(
          spec,
          mine.map((entry) => ({ entry, identity_keys: identityKeysOf(spec, entry.reading.variables), variables: entry.reading.variables })),
          unpaired,
        );
        for (const [{ entry: partner }, loose] of proven) {
          const looseRead = { ...loose, data: loose.data as Readonly<Record<string, unknown>> | null };
          // Joined late, after the AI answered: each value from the pass that
          // ranks first — rules, then the markup, then the AI — not the
          // template's answers over what the markup read.
          const combined = combineFactsByPass(spec, { ...partner.reading, position: partner.fact.position }, looseRead);
          partner.reading = {
            variables: combined.variables,
            passes: combined.passes,
            data: combined.data,
            refused: combined.refused,
            missing: combined.missing,
            complete: combined.complete,
          };
          store.deleteFacts([loose.fact_id]);
        }
        // What no answer proved waits while a fact of the email reads no
        // identity yet — it may be that one's — and is its own thing once
        // none does.
        const answeredIds = new Set(mine.map((entry) => entry.fact.fact_id));
        const stillBlind = onEmail.some((fact) => fact.template_id !== null && !answeredIds.has(fact.fact_id) && fact.identity_keys.length === 0)
          || mine.some((entry) => identityKeysOf(spec, entry.reading.variables).length === 0);
        if (stillBlind) continue;
        const joined = new Set(proven.values());
        for (const loose of unpaired) if (!joined.has(loose)) alone.push({ fact: loose, spec });
      }
      for (const { fact, spec, reading, ai } of answered) {
        // As the kind is now: a variable it gained while the fact waited is
        // there, empty, and missing when it is required — the fact said it
        // was complete while its thing said it was not.
        const variables: Record<string, MailFactValue | null> = {
          ...Object.fromEntries(mailFactTypeVariables(spec).map((variable) => [variable.name, null])),
          ...reading.variables,
        };
        const missing = spec.variables
          .filter((variable) => variable.required && (variables[variable.name] ?? null) === null)
          .map((variable) => variable.name);
        const identity_keys = identityKeysOf(spec, variables);
        const announce = stored.may_trigger && live && !fact.announced;
        const next: StoredMailFact = {
          ...fact,
          variables,
          passes: reading.passes,
          data: reading.data,
          refused: reading.refused,
          missing,
          complete: missing.length === 0,
          identity_keys,
          thing_id: placement.thingFor(spec, identity_keys, fact.prior_thing_id),
          ai,
          announced: fact.announced || announce,
          prior_thing_id: null,
        };
        store.updateFact(next);
        placement.placed(next, spec, announce);
        placed += 1;
      }
      for (const { fact, spec } of alone) {
        // The markup's own facts, placed now: news for a live email, but a
        // backfill announces only its template's facts (§6.3).
        const announce = stored.may_trigger && live && !fact.announced && stored.origin !== 'backfill';
        const next: StoredMailFact = {
          ...fact,
          thing_id: placement.thingFor(spec, fact.identity_keys),
          announced: fact.announced || announce,
        };
        store.updateFact(next);
        placement.placed(next, spec, announce);
        placed += 1;
      }
      events.push(...placement.fold(at, stored.origin));
    });
    emitAll(events);
    if (placed > 0) changed('facts');
    return { facts: placed, events: events.length };
  };

  const removeEmails = (slug: string, record_ids: readonly string[]): void => {
    if (record_ids.length === 0) return;
    const at = deps.now();
    const removed = store.transaction(() => {
      // Runs first: an email whose facts a re-read already dropped can still
      // hold the runs they started.
      store.deleteRunsForEmails(slug, record_ids);
      store.deleteAiJobsForEmails(slug, record_ids);
      store.deleteEmailLedgers(slug, record_ids);
      store.deleteEmailMovesTo(slug, record_ids);
      const facts = store.factsForEmails(slug, record_ids);
      dropFacts(facts, at);
      return facts.length;
    });
    if (removed > 0) changed('facts');
  };

  const rekeyEmail = (slug: string, old_record_id: string, new_record_id: string): void => {
    const at = deps.now();
    const { moved, events } = store.transaction(() => {
      const target = { slug, record_id: new_record_id };
      const source = { slug, record_id: old_record_id };
      // A run its facts started can end after the move: it is linked where
      // the email is now (§6.4).
      if (store.getEmailLedger(source) !== null || store.factsForEmail(source).length > 0) {
        store.recordEmailMove(slug, old_record_id, new_record_id, at);
      }
      // News the old id's call held — facts that waited on the AI, never told
      // — goes with the email, as its runs do: a call the new id has for the
      // template carries it.
      const uncarried = store.aiJobsForEmail(source).filter((job) => {
        if (!job.may_trigger) return false;
        if (!store.aiJobsForEmail(target).some((other) => other.template_id === job.template_id)) return true;
        store.carryAiNews(target, job.template_id, job.origin ?? null);
        return false;
      });
      // Not read under its new id yet — no facts, and at most the mark the
      // sync set when it saw the message there: the email moves whole, what it
      // told included, and the mark goes with the old row it duplicates. Read
      // under the new id, that mark would have told the email's news again.
      const targetLedger = store.getEmailLedger(target);
      if (store.factsForEmail(target).length === 0 && (targetLedger === null || targetLedger.fingerprint === null)) {
        return { moved: store.rekeyEmail(slug, old_record_id, new_record_id), events: [] };
      }
      // The sync read the moved copy under its new id first: that reading is
      // the email's now, and the old id's facts would be a second copy of it.
      // What they told, its facts told — a backfill that runs recipes must not
      // tell it again — and its place among mail of its date is the old id's
      // when that is earlier. Its runs follow it; the rest goes, as a deleted
      // email's does.
      const placement = createPlacement();
      // A fact is one the old id told when it could be only that one, by the
      // rule every matcher shares: a return of another number shares the
      // order's key with the one told, and was never told.
      const told = store.factRecordsForEmail(source).filter((fact) => fact.announced);
      const heard = pairEach({
        readings: store.factRecordsForEmail(target).filter((fact) => !fact.announced),
        candidates: told,
        could: (fact, was) => {
          const spec = typeSpecOf(store, fact.type);
          return spec !== undefined && was.type === fact.type && was.template_id === fact.template_id
            && couldBeRead(spec, fact, fact.identity_keys, was);
        },
        readingsApart: (a, b) => identitiesDisagree(a.identity_keys, b.identity_keys),
        candidatesApart: (a, b) => identitiesDisagree(a.identity_keys, b.identity_keys),
        rank: (fact, a, b) => Number(b.position === fact.position) - Number(a.position === fact.position) || a.position - b.position,
        readingRank: (a, b) => a.position - b.position,
        share: true,
      });
      for (const fact of heard.keys()) store.updateFact({ ...fact, announced: true });
      // Read first under the old id, the email keeps that reading's date and
      // place: read again under the new one, a future-dated transit notice was
      // dated then — past the delivery that came since.
      const first = store.getEmailLedger(source);
      if (first?.arrival !== undefined && first.arrival !== null
        && store.takeEarlierReading(target, first.arrival, mailFactEmailDate(store, source, first.email_at ?? at))) {
        for (const fact of store.factRecordsForEmail(target)) {
          const spec = typeSpecOf(store, fact.type);
          if (spec !== undefined && fact.thing_id !== null) placement.touch(fact.thing_id, spec);
        }
      }
      // What that reading did not read stays the email's, as a reading of one
      // id keeps it (§4.3): a fact of a template switched off or deleted, or of
      // a standards kind switched off, when the new id holds none of that
      // template's, or of that kind's pass. It moves with the call it waits
      // on, and a pass's reading it took in, read again beside it under the
      // new id, goes. A security notice keeps nothing.
      const standardsOff = store.standardsOff();
      const activeIds = new Set(store.listTemplates({ active: true }).map((template) => template.template_id));
      const onTarget = store.factRecordsForEmail(target);
      const retained = targetLedger?.skipped === 'security_notice' ? [] : store.factRecordsForEmail(source).filter((fact) =>
        (fact.template_id !== null ? !activeIds.has(fact.template_id) : standardsOff.has(fact.type))
        && !onTarget.some((other) => (fact.template_id !== null
          ? other.template_id === fact.template_id
          : other.template_id === null && other.type === fact.type)));
      let absorbed = 0;
      if (retained.length > 0) {
        store.moveFacts(source, target, retained.map((fact) => fact.fact_id), mailFactEmailDate(store, target, mailFactEmailDate(store, source, at)));
        for (const type of new Set(retained.map((fact) => fact.type))) {
          const spec = typeSpecOf(store, type);
          if (spec === undefined) continue;
          const holders = retained.filter((fact) => fact.type === type);
          const readings = onTarget.filter((fact) => fact.template_id === null && fact.type === type);
          const taken = [...matchOneToOne(spec, holders, readings).values()];
          store.deleteFacts(taken.map((fact) => fact.fact_id));
          absorbed += taken.length;
          for (const fact of [...holders, ...taken]) if (fact.thing_id !== null) placement.touch(fact.thing_id, spec);
        }
      }
      store.moveRuns(slug, old_record_id, new_record_id);
      store.deleteAiJobsForEmails(slug, [old_record_id]);
      store.deleteEmailLedgers(slug, [old_record_id]);
      const facts = store.factsForEmails(slug, [old_record_id]);
      dropFacts(facts, at);
      // The new id's call for the template answered already: its facts there,
      // placed and never told, are the news the old id's call held.
      for (const job of uncarried) {
        const template = store.getTemplate(job.template_id);
        // Deleted or switched off meanwhile: it starts nothing (§4.3).
        if (template === null || !template.active) continue;
        const spec = typeSpecOf(store, template.type);
        if (spec === undefined) continue;
        for (const fact of store.factRecordsForEmail(target)) {
          if (fact.template_id !== job.template_id || fact.announced || fact.thing_id === null) continue;
          const announced: StoredMailFact = { ...fact, announced: true };
          store.updateFact(announced);
          placement.placed(announced, spec, true, job.origin ?? 'live');
        }
      }
      return { moved: facts.length + retained.length + absorbed, events: placement.fold(at, undefined) };
    });
    emitAll(events);
    if (moved > 0 || events.length > 0) changed('facts');
  };

  const markNews = (ref: MailFactEmailRef): void => {
    store.markEmailNews(ref);
  };

  const sweepGone = (slug: string, holds: (record_id: string) => boolean, after: string | null): string | null => {
    const page = store.emailIdsOf(slug, after, MAIL_FACT_SWEEP_PAGE);
    removeEmails(slug, page.filter((record_id) => !holds(record_id)));
    return page.length < MAIL_FACT_SWEEP_PAGE ? null : page[page.length - 1]!;
  };

  return { write, markNews, applyAi, removeEmails, rekeyEmail, sweepGone };
};
