/** D-336 — a saved fact's claim, as `memory.write` takes it and as an import brings it.
 *
 *  A call writes each end as words, `"owner"` for the user, `{contact: target_id}` for
 *  a person found with `contact.search`, or `{asset: id}` for a thing the user owns.
 *  The relation must be one the list holds (`MEMORY_RELATIONS`): agents keep to the
 *  list so that what they write stays uniform, and a fact no relation fits is saved
 *  without a claim (§3.11). Each end must be the kind its relation names: a contact
 *  or the owner where a person goes, an asset where a thing goes; words go anywhere.
 *
 *  A linked end is stored as its record's id, which the key uses, and the name it had,
 *  which export writes beside it. A contact end also links the note to the contact as
 *  `provenance_entity_ids` does (§3.2).
 *
 *  Spec: D-336 §3.2, §3.8. */

import {
  MEMORY_CLAIM_PART_MAX,
  listedMemoryRelation,
  memoryClaimEndKey,
  memoryClaimKey,
  memoryClaimSentence,
  memoryRelationsExclude,
  parseQualifiedWorkEntityId,
  qualifyWorkEntityId,
  normalizeClaimText,
  readMemoryClaim,
  type ContactRecord,
  type MemoryClaim,
  type MemoryClaimEnd,
  type MemoryRelationEnd,
  type MemoryRelationEntry,
} from '@recued/contracts';

import { liveReplacementOf } from './memory-revision.js';
import type { ContactStore } from './storage/contact-store.js';
import { claimEndsLikeIn, type UserMemoryRow, type UserMemoryStore } from './user-memory-store.js';
import type { WorkEntityStore } from './storage/work-entity-store.js';
import { createWorkEntityResolver } from './work-entity-resolver.js';

/** One end as a call writes it, before its record is looked up. */
export type ClaimArgEnd =
  | { readonly text: string }
  | { readonly owner: true }
  | { readonly contact: string }
  | { readonly asset: string };

/** A call's claim, its relation found in the list and its ends read. */
export interface ClaimArg {
  readonly subject: ClaimArgEnd;
  readonly relation: MemoryRelationEntry;
  readonly object: ClaimArgEnd;
}

export type ClaimChecked<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

const refuse = (message: string): { ok: false; message: string } => ({ ok: false, message });

const KIND_WORDS: Readonly<Record<MemoryRelationEnd, string>> = {
  person: 'a person', thing: 'a thing', place: 'a place', name: 'a name', text: 'words',
};

/** Read one end: `what` names it in a refusal ("the claim's subject"). */
const parseEnd = (raw: unknown, what: string): ClaimChecked<ClaimArgEnd> => {
  if (typeof raw === 'string') {
    const words = raw.trim().replace(/\s+/gu, ' ');
    if (words.length === 0) return refuse(`${what} is empty`);
    if (words.length > MEMORY_CLAIM_PART_MAX) {
      return refuse(`${what} is longer than ${MEMORY_CLAIM_PART_MAX} characters; keep each part short and leave the rest to the summary`);
    }
    return { ok: true, value: normalizeClaimText(words) === 'owner' ? { owner: true } : { text: words } };
  }
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    const only = Object.keys(record);
    const id = (key: 'contact' | 'asset'): string | undefined =>
      only.length === 1 && typeof record[key] === 'string' && (record[key] as string).trim() !== ''
        ? (record[key] as string).trim()
        : undefined;
    const contact = id('contact');
    if (contact !== undefined) return { ok: true, value: { contact } };
    const asset = id('asset');
    if (asset !== undefined) return { ok: true, value: { asset } };
  }
  return refuse(`${what} must be a name or short phrase, "owner", {"contact": target_id} or {"asset": id}`);
};

/** Whether an end may stand where its relation puts an end of `kind`. */
const fits = (end: ClaimArgEnd | MemoryClaimEnd, kind: MemoryRelationEnd): boolean => {
  if ('text' in end) return true;
  if ('owner' in end || 'contact' in end || 'contact_id' in end) return kind === 'person';
  return kind === 'thing';
};

const endNoun = (end: ClaimArgEnd): string =>
  'asset' in end ? 'an asset' : 'contact' in end ? 'a contact' : 'the owner';

/** Read a call's `claim`: its relation must be listed and each end the kind the
 *  relation names. Records are not looked up here (`resolveClaimArg`), so this runs
 *  before the call's grant is checked. */
export const parseClaimArg = (raw: unknown): ClaimChecked<ClaimArg> => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return refuse('claim must be an object with a subject, a relation and an object');
  }
  const record = raw as Record<string, unknown>;
  const words = typeof record.relation === 'string' ? record.relation.trim() : '';
  if (words === '') return refuse('the claim needs a relation; memory.relations lists them');
  const relation = listedMemoryRelation(words);
  if (relation === undefined) {
    return refuse(`"${words.slice(0, 80)}" is not a relation memory.relations lists. Call memory.relations `
      + 'and use one of its relations, or save without a claim when none fits');
  }
  const subject = parseEnd(record.subject, "the claim's subject");
  if (!subject.ok) return subject;
  const object = parseEnd(record.object, "the claim's object");
  if (!object.ok) return object;
  for (const [end, kind, which] of [
    [subject.value, relation.subject, 'subject'],
    [object.value, relation.object, 'object'],
  ] as const) {
    if (!fits(end, kind)) {
      return refuse(`the ${which} of "${relation.relation}" is ${KIND_WORDS[kind]}, so it cannot be ${endNoun(end)}; write it as words`);
    }
  }
  return { ok: true, value: { subject: subject.value, relation, object: object.value } };
};

/** A record a linked end names: found, not found (`null`), or one this caller may not
 *  read, with the sentence that says so. */
export type ClaimRecordLookup<T> = (id: string) => Promise<T | null | { readonly refused: string }>;

export interface ClaimRecords {
  /** A contact by `contact.search`'s `target_id`, or by its `contact_id`. */
  contact: ClaimRecordLookup<{ contact_id: string; name: string; email: string }>;
  /** A thing the user owns by the id the work tools return. */
  asset: ClaimRecordLookup<{ asset_id: string; name: string }>;
}

/** Look up one end's record, as the caller could read it. A contact's email is added to
 *  `links`, which link a saved note to the contact. */
const resolveEnd = async (
  end: ClaimArgEnd,
  records: ClaimRecords,
  links: string[],
): Promise<ClaimChecked<MemoryClaimEnd>> => {
  if ('text' in end || 'owner' in end) return { ok: true, value: end };
  if ('contact' in end) {
    const found = await records.contact(end.contact);
    if (found === null) {
      return refuse(`no contact has target_id '${end.contact}'; find them with contact.search, or write the person's name instead`);
    }
    if ('refused' in found) return refuse(found.refused);
    links.push(found.email);
    return { ok: true, value: { contact_id: found.contact_id, name: found.name } };
  }
  const found = await records.asset(end.asset);
  if (found === null) {
    return refuse(`the user owns no thing with id '${end.asset}'; find it with work.search, or write its name instead`);
  }
  if ('refused' in found) return refuse(found.refused);
  return { ok: true, value: { asset_id: found.asset_id, name: found.name } };
};

/** Look up a parsed claim's linked ends. Returns the claim as it is stored and the
 *  contacts' emails, which link the note to them (`provenance_entity_ids`). */
export const resolveClaimArg = async (
  claim: ClaimArg,
  records: ClaimRecords,
): Promise<ClaimChecked<{ claim: MemoryClaim; links: string[] }>> => {
  const links: string[] = [];
  const subject = await resolveEnd(claim.subject, records, links);
  if (!subject.ok) return subject;
  const object = await resolveEnd(claim.object, records, links);
  if (!object.ok) return object;
  return {
    ok: true,
    value: { claim: { subject: subject.value, relation: claim.relation.relation, object: object.value }, links: [...new Set(links)] },
  };
};

/** The records a claim's linked ends are looked up in, as the owner: a contact by
 *  `contact.search`'s `target_id` or by its `contact_id`, followed through a merge, and a
 *  thing the owner keeps by the id the work tools return, given back as `work.read` gives
 *  it. Used where the owner acts (import) or asks (the Delete count), so nothing is
 *  fenced; an agent's save looks its records up as it could read them (`ClaimRecords`). */
export interface ClaimRecordLookups {
  /** `email`, where the lookup has it: what links a note to the contact (slice E). */
  contact?: (id: string) => { contact_id: string; name: string; email?: string } | null;
  asset?: (id: string) => { asset_id: string; name: string } | null;
}

const lookUp = <T,>(find: ((id: string) => T | null) | undefined, id: string): T | null => {
  try {
    return find?.(id) ?? null;
  } catch {
    return null;
  }
};

/** An exported claim brought in (D-336 §3.8): a linked end keeps its record when that
 *  record exists here and otherwise becomes its name; a relation not in this server's
 *  list comes in as written, like the owner's own. A listed relation's ends are checked
 *  as a saved claim's are. `undefined` for a claim that is not one: the note is still
 *  imported, without it. */
export const importedClaim = (raw: unknown, records: ClaimRecordLookups): MemoryClaim | undefined => {
  const claim = readMemoryClaim(raw);
  if (claim === undefined) return undefined;
  const bring = (end: MemoryClaimEnd): MemoryClaimEnd => {
    if ('contact_id' in end) {
      const found = lookUp(records.contact, end.contact_id);
      if (found === null) return { text: end.name };
      // Audit 2026-11-01 (second) — a contact merged into another is found as the survivor,
      // and is still here: the note keeps naming it, as saved. Given the survivor's id, a
      // split left the note on the wrong person, and the same file again added a copy (its
      // key no longer the saved one). The merge group matches it meanwhile (`claimEndsLike`).
      return found.contact_id === end.contact_id ? { contact_id: found.contact_id, name: found.name } : end;
    }
    if ('asset_id' in end) {
      const found = lookUp(records.asset, end.asset_id);
      return found === null ? { text: end.name } : { asset_id: found.asset_id, name: found.name };
    }
    return end;
  };
  const subject = bring(claim.subject);
  const object = bring(claim.object);
  const listed = listedMemoryRelation(claim.relation);
  if (listed !== undefined && (!fits(subject, listed.subject) || !fits(object, listed.object))) return undefined;
  return { subject, relation: listed?.relation ?? claim.relation, object };
};

/** D-336 slice B — the key a `memory.write` call's claim made, worked out again from the
 *  call: a deleted note's key, which Delete erased, read back from the chat that saved it.
 *  A linked end is looked up as the save looked it up; one that cannot be is no key, which
 *  only leaves the words to match (`undefined` for a claim the save would have refused).
 *  A claim the owner changed on the card while approving (slice E) is recorded as their
 *  forms write it, and keyed as it was saved. */
export const claimKeyOfCall = (raw: unknown, records: ClaimRecordLookups = {}): string | undefined => {
  const claim = claimOfCall(raw, records);
  return claim === undefined ? undefined : memoryClaimKey(claim);
};

/** The claim `claimKeyOfCall` keys: a call's claim as it would be saved, its linked ends
 *  looked up as the save looks them up. Slice S compares two waiting saves' claims by it. */
export const claimOfCall = (raw: unknown, records: ClaimRecordLookups = {}): MemoryClaim | undefined => {
  if (raw === undefined || raw === null) return undefined;
  const owners = readMemoryClaim(raw);
  if (owners !== undefined) return owners;
  const parsed = parseClaimArg(raw);
  if (!parsed.ok) return undefined;
  const end = (arg: ClaimArgEnd): MemoryClaimEnd | undefined => {
    if ('text' in arg || 'owner' in arg) return arg;
    if ('contact' in arg) {
      const found = lookUp(records.contact, arg.contact);
      return found === null ? undefined : { contact_id: found.contact_id, name: found.name };
    }
    const found = lookUp(records.asset, arg.asset);
    return found === null ? undefined : { asset_id: found.asset_id, name: found.name };
  };
  const subject = end(parsed.value.subject);
  const object = end(parsed.value.object);
  return subject === undefined || object === undefined
    ? undefined
    : { subject, relation: parsed.value.relation.relation, object };
};

/** D-336 slice S — whether two claims cannot both hold, by the rule a note in memory is
 *  contradicted (`findClaimConflicts`): the same two ends, by key, with relations the list
 *  says exclude each other. As there, a name and a linked contact are two ends, and a claim
 *  written the other way round is not compared. */
export const claimsContradict = (a: MemoryClaim, b: MemoryClaim): boolean =>
  memoryClaimEndKey(a.subject) === memoryClaimEndKey(b.subject)
  && memoryClaimEndKey(a.object) === memoryClaimEndKey(b.object)
  && memoryRelationsExclude(normalizeClaimText(a.relation), normalizeClaimText(b.relation));

/** The owner's lookups (`ClaimRecordLookups`) over this server's contacts and things. */
export const ownerClaimRecords = (stores: {
  contacts?: Pick<ContactStore, 'get' | 'getByContactIdResolved' | 'resolveCanonicalEmail'>;
  work?: WorkEntityStore;
}): ClaimRecordLookups => {
  const resolver = stores.work === undefined ? undefined : createWorkEntityResolver(stores.work);
  const contacts = stores.contacts;
  return {
    ...(contacts !== undefined ? {
      contact: (id: string) => {
        let row: ContactRecord | null;
        if (id.includes('@')) {
          let canonical = id.trim().toLowerCase();
          try { canonical = contacts.resolveCanonicalEmail(id).canonical_email; } catch { /* a broken chain: read the row itself */ }
          row = contacts.get(canonical);
        } else {
          row = contacts.getByContactIdResolved(id);
        }
        if (row === null || row.contact_id === undefined) return null;
        const name = row.name?.trim();
        return { contact_id: row.contact_id, name: name !== undefined && name !== '' ? name : row.email, email: row.email };
      },
    } : {}),
    ...(resolver !== undefined ? {
      asset: (id: string) => {
        const qualified = parseQualifiedWorkEntityId(id);
        const row = qualified === null ? resolver.readEntity('asset', id)
          : qualified.kind !== 'asset' ? null
            : qualified.identity === 'source'
              ? resolver.readEntityBySourceIdentity('asset', qualified.source_id, qualified.record_id)
              : resolver.readEntity('asset', qualified.record_id);
        if (row === null || row._kind !== 'asset') return null;
        const name = row.name.trim();
        return {
          // The id `work.read` gives, which a save's claim stores.
          asset_id: qualifyWorkEntityId({
            kind: row._kind,
            source_id: row.source_id,
            ...(row.source_record_id !== undefined ? { source_record_id: row.source_record_id } : {}),
            local_id: row.id,
          }),
          name: name !== '' ? name : 'a thing you own',
        };
      },
    } : {}),
  };
};

/** D-336 audit 2026-11-01 — the end keys naming the person a contact end names: every
 *  contact of its merge group, the survivor and each contact merged into it, at any depth.
 *  A merge moves nothing (D-205 rule 2), so a note saved before it keeps the absorbed
 *  contact's id while every lookup now finds the survivor's; matching by this group keeps
 *  the note found in recall and on the contact's page, and a revoked claim refused however
 *  the person is named. A split takes the contact out of the group again. Not a contact end,
 *  or a contact not here: the key alone. The memory store's `sameClaimEnd`. */
export const contactClaimEnds = (
  contacts: Pick<ContactStore, 'get' | 'getByContactIdResolved' | 'listMergedSourceEmails'>,
) => (end_key: string): string[] => {
  if (!end_key.startsWith('contact:')) return [end_key];
  const id = end_key.slice('contact:'.length);
  const survivor = contacts.getByContactIdResolved(id);
  if (survivor?.contact_id === undefined) return [end_key];
  const ids = new Set([id, survivor.contact_id]);
  for (const email of contacts.listMergedSourceEmails(survivor.email)) {
    const absorbed = contacts.get(email)?.contact_id;
    if (absorbed !== undefined) ids.add(absorbed);
  }
  return [...ids].map((member) => `contact:${member}`);
};

/** D-336 slice C — the ends `memory.search`'s `about` names, as keys: one name, or two for
 *  how two are related, each written as a claim writes an end. A linked end is looked up as
 *  the caller could read it. The same end twice is one. */
export const aboutEndKeys = async (
  raw: unknown,
  records: ClaimRecords,
): Promise<ClaimChecked<string[]>> => {
  const items = Array.isArray(raw) ? raw : [raw];
  if (items.length === 0 || items.length > 2) {
    return refuse('`about` takes one name, or two names for how two are related');
  }
  const keys: string[] = [];
  for (const item of items) {
    const end = parseEnd(item, 'each name in `about`');
    if (!end.ok) return end;
    const resolved = await resolveEnd(end.value, records, []);
    if (!resolved.ok) return resolved;
    keys.push(memoryClaimEndKey(resolved.value));
  }
  return { ok: true, value: [...new Set(keys)] };
};

/** D-336 slice C — the rows whose claim names those ends: one end as its subject or its
 *  object; two as its two ends, either way round ("Mia, daughter of, Dana" and "Dana,
 *  mother of, Mia" both join Mia and Dana). Removed notes are the caller's to drop. */
export const rowsAbout = async (
  store: Pick<UserMemoryStore, 'listClaimEnd'> & Partial<Pick<UserMemoryStore, 'claimEndsLike'>>,
  keys: readonly string[],
): Promise<UserMemoryRow[]> => {
  const [first, second] = keys;
  if (first === undefined) return [];
  const rows = await store.listClaimEnd(first);
  if (second === undefined) return rows;
  // Each end as every key naming its record: a merged contact's notes join too.
  const a = claimEndsLikeIn(store, first);
  const b = claimEndsLikeIn(store, second);
  const is = (ends: ReadonlySet<string>, key: string | undefined): boolean => key !== undefined && ends.has(key);
  return rows.filter((r) => (is(a, r.claim_subject) && is(b, r.claim_object)) || (is(b, r.claim_subject) && is(a, r.claim_object)));
};

/** The kinds of end, as the owner reads them in a refusal. */
const OWNER_KIND_WORDS: Readonly<Record<MemoryRelationEnd, string>> = {
  person: 'a person', thing: 'a thing', place: 'a place', name: 'a name', text: 'words',
};

const ownerEndNoun = (end: MemoryClaimEnd): string =>
  'contact_id' in end ? 'a contact' : 'asset_id' in end ? 'a thing you own' : 'you';

/** D-336 slice E — a claim the owner wrote in their own form (add, edit, Replace). Their
 *  own relation is as valid as a listed one (§3.11). A listed relation's ends are checked
 *  as a save's are, and a linked end must still be here; its name is refreshed from its
 *  record. The refusals are in the owner's words, for the form to show. */
export const ownerClaim = (raw: unknown, records: ClaimRecordLookups): ClaimChecked<MemoryClaim> => {
  const claim = readMemoryClaim(raw);
  if (claim === undefined) {
    return refuse('A relationship needs a first part, a relation and a second part, each up to 200 characters.');
  }
  const bring = (end: MemoryClaimEnd): ClaimChecked<MemoryClaimEnd> => {
    if ('contact_id' in end) {
      const found = lookUp(records.contact, end.contact_id);
      return found === null
        ? refuse(`${end.name} is not in your contacts any more. Choose another contact, or write the name.`)
        : { ok: true, value: { contact_id: found.contact_id, name: found.name } };
    }
    if ('asset_id' in end) {
      const found = lookUp(records.asset, end.asset_id);
      return found === null
        ? refuse(`${end.name} is not among the things you own any more. Choose another, or write its name.`)
        : { ok: true, value: { asset_id: found.asset_id, name: found.name } };
    }
    return { ok: true, value: end };
  };
  const subject = bring(claim.subject);
  if (!subject.ok) return subject;
  const object = bring(claim.object);
  if (!object.ok) return object;
  const listed = listedMemoryRelation(claim.relation);
  if (listed !== undefined) {
    for (const [end, kind, place] of [
      [subject.value, listed.subject, 'first'],
      [object.value, listed.object, 'second'],
    ] as const) {
      if (!fits(end, kind)) {
        return refuse(`“${listed.relation}” takes ${OWNER_KIND_WORDS[kind]} as its ${place} part, not ${ownerEndNoun(end)}.`);
      }
    }
  }
  return { ok: true, value: { subject: subject.value, relation: listed?.relation ?? claim.relation, object: object.value } };
};

/** D-336 slice E — the emails of the contacts a claim links, which link its note to them as
 *  an agent's save does (§3.2). A contact the lookups cannot find, or give no email for, adds
 *  none. */
export const claimContactEmails = (claim: MemoryClaim, records: ClaimRecordLookups): string[] => [
  ...new Set([claim.subject, claim.object].flatMap((end) => {
    if (!('contact_id' in end)) return [];
    const email = lookUp(records.contact, end.contact_id)?.email;
    return email !== undefined && email !== '' ? [email] : [];
  })),
];

/** D-336 slice G (§3.9) — the notes a claim meets in memory, newest first:
 *  - `contradicts`: the same subject and object, with a relation the list says excludes its
 *    own ("Mia, sister of, Dana" against "Mia, daughter of, Dana");
 *  - `same` (slice J): the same subject, relation and object, the fact saved already in any
 *    wording ("Mia is Dana's daughter" against "Dana's daughter is called Mia"). Told, never
 *    refused: the new note may say more;
 *  - `also`: the same subject and relation with another object ("Dana, lives in, Cork"
 *    against "Dana, lives in, Dublin"). No relation holds only one object, so this cannot
 *    tell a second value, a change and a mistake apart: it is only told.
 *
 *  Only what memory holds is compared: never a note under the overlay (forgotten, hidden,
 *  deleted or revoked), a version replaced by one that stands, or one in `lineage` (the note
 *  a save replaces and its earlier versions). The ends are compared by key, so a name and a
 *  linked contact are two ends, and a note written the other way round is not compared. */
export interface ClaimConflicts {
  readonly contradicts: readonly UserMemoryRow[];
  readonly same: readonly UserMemoryRow[];
  readonly also: readonly UserMemoryRow[];
}

export const findClaimConflicts = async (
  store: Pick<UserMemoryStore, 'listClaimEnd' | 'replacementsOf'> & Partial<Pick<UserMemoryStore, 'claimEndsLike'>>,
  removed: ReadonlySet<string>,
  claim: MemoryClaim,
  lineage: ReadonlySet<string> = new Set(),
): Promise<ClaimConflicts> => {
  const subject = memoryClaimEndKey(claim.subject);
  const object = memoryClaimEndKey(claim.object);
  // A merged contact's notes name it by its own id (`claimEndsLike`).
  const subjects = claimEndsLikeIn(store, subject);
  const objects = claimEndsLikeIn(store, object);
  const relation = normalizeClaimText(claim.relation);
  const contradicts: UserMemoryRow[] = [];
  const same: UserMemoryRow[] = [];
  const also: UserMemoryRow[] = [];
  for (const row of await store.listClaimEnd(subject)) {
    if (row.claim_subject === undefined || !subjects.has(row.claim_subject) || row.claim === undefined) continue;
    if (removed.has(row.memory_id) || lineage.has(row.memory_id)) continue;
    const theirs = normalizeClaimText(row.claim.relation);
    const found = row.claim_object !== undefined && objects.has(row.claim_object)
      ? theirs === relation ? same : memoryRelationsExclude(theirs, relation) ? contradicts : undefined
      : theirs === relation ? also : undefined;
    if (found === undefined) continue;
    if (await liveReplacementOf(store, removed, row.memory_id) !== undefined) continue;
    found.push(row);
  }
  const newest = (a: UserMemoryRow, b: UserMemoryRow): number =>
    (b.event_at ?? b.ts) - (a.event_at ?? a.ts) || (a.memory_id < b.memory_id ? 1 : -1);
  return { contradicts: contradicts.sort(newest), same: same.sort(newest), also: also.sort(newest) };
};

/** The note `memory_id` and the earlier versions it replaced, its `replaces` chain: a save
 *  that replaces it is compared with none of them. */
export const lineageOf = async (
  store: Pick<UserMemoryStore, 'getRow'>,
  memory_id: string,
): Promise<Set<string>> => {
  const ids = new Set<string>();
  let id: string | undefined = memory_id;
  // Bounded, as the other lineage walks are: a corrupt cycle stays finite.
  while (id !== undefined && !ids.has(id) && ids.size < 200) {
    ids.add(id);
    id = (await store.getRow(id))?.replaces;
  }
  return ids;
};

/** How a note another meets is named: its summary, or for one saved without a summary, its
 *  claim as a sentence. A note this finds always has a claim. */
export const conflictSummary = (row: UserMemoryRow): string => {
  const summary = row.summary?.trim();
  if (summary !== undefined && summary !== '') return summary;
  return row.claim !== undefined ? memoryClaimSentence(row.claim) : row.kind;
};
