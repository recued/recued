/** D-198 §10 — an agent replaces or forgets its OWN pool entries; §12 — the owner
 *  replaces an agent's entry with their own version (`checkOwnerReplace`).
 *
 *  The pool was add-only for an agent: a correction became a second entry, and
 *  recall returned both as equally-ranked contradictions. An agent may now revise
 *  the `contracted_user` rows it wrote, and nothing else, while every revision
 *  stays a NEW row or an overlay mark the owner can reverse:
 *    - **replace**: a new row points at the old one (`replaces`); the old row is
 *      never touched. An entry is current unless it is forgotten, or a row that
 *      is NOT forgotten replaces it — so the owner undoes a replacement by
 *      forgetting the newer version, and the older one is current again.
 *    - **forget**: the existing redaction overlay, recorded with the forgetting
 *      contract, over the entry and every earlier version it replaced. The owner
 *      undoes it with `memory.restore`, which deletes exactly those marks.
 *
 *  ⛔ The owner's reversal of both acts is what keeps `memory.write` and
 *  `memory.forget` out of plan approval (`classification: 'unknown'`). An
 *  irreversible revision would have to classify as `write`.
 *
 *  Spec: D-198 §10. */

import type Database from 'better-sqlite3';
import { FTS_STOPWORDS, tokenizeFtsQuery } from '@recued/fts';
import type { Collection } from '@recued/storage';
import type { MemoryRedactionRecord } from './memory-rpc-handler.js';
import { createSQLiteCollection } from './sqlite-collection.js';
import type { UserMemoryRow, UserMemoryStore } from './user-memory-store.js';

/** The table the redaction overlay lives in, beside `links` and the audit log. */
export const MEMORY_REDACTION_TABLE = 'memory_redactions';

/** The redaction overlay on `db`. Boot opens it once for the memory handlers; a
 *  reader that holds only the database handle opens it here.
 *
 *  ⛔ The run readers an AI reaches (`data.timeline` in all three channels, the
 *  MCP run history) are composed in four places, one of them a separate stdio
 *  process that wires no memory stores at all. A store each of them had to be
 *  handed would fail OPEN wherever one was missed, and a forgotten run would come
 *  back with its output. Reading the marks off the handle their own query runs on
 *  cannot be missed: no database, no runs to read, no marks to honour. */
export const openMemoryRedactionStore = (
  db: Database.Database,
): Collection<MemoryRedactionRecord> =>
  createSQLiteCollection<MemoryRedactionRecord>(db, MEMORY_REDACTION_TABLE);

/** A replace lineage longer than this is treated as ending here. Real lineages
 *  are a handful of versions; the bound only keeps a corrupt cycle finite. */
const MAX_LINEAGE = 200;

/** The contract that authored a row, for the ownership check: only an agent's
 *  (`contracted_user`) row has one. `author_contract_id` from §10 on; a door's
 *  earlier rows carry the door's `contract_id`, stamped from the door at write
 *  time. The owner chat's earlier rows carry neither and have NO provable author,
 *  so no agent may revise them — never inferred from absence. */
export const memoryRowAuthor = (row: UserMemoryRow): string | undefined =>
  row.origin_actor === 'contracted_user'
    ? (row.author_contract_id ?? row.contract_id)
    : undefined;

/** The ids under the redaction overlay (owner redactions and agent forgets). */
export const forgottenIds = async (
  redactions: Collection<MemoryRedactionRecord> | undefined,
): Promise<Set<string>> => forgottenIn(redactions ? await redactions.list() : []);

/** `forgottenIds`, from marks a caller has already read. */
export const forgottenIn = (marks: readonly MemoryRedactionRecord[]): Set<string> =>
  new Set(marks.map((r) => r.memory_id));

/** D-198 §13 — the owner's revokes among marks already read, by version id: when, and
 *  the head the owner revoked (every version of the lineage carries the head's revoke). */
export const revokesIn = (
  marks: readonly MemoryRedactionRecord[],
): Map<string, { revoked_at: number; head: string }> =>
  new Map(
    marks
      .filter((r) => r.revoked === true)
      .map((r) => [r.memory_id, { revoked_at: r.redacted_at, head: r.revoke_of ?? r.memory_id }]),
  );

/** The row that replaces `memory_id` and still counts: not forgotten. The newest
 *  wins if a race ever left two. */
export const liveReplacementOf = async (
  store: Pick<UserMemoryStore, 'replacementsOf'>,
  forgotten: ReadonlySet<string>,
  memory_id: string,
): Promise<UserMemoryRow | undefined> =>
  (await store.replacementsOf(memory_id))
    .filter((r) => !forgotten.has(r.memory_id))
    .sort((a, b) => b.ts - a.ts || (a.memory_id < b.memory_id ? 1 : -1))[0];

/** Follow live replacements forward to the CURRENT version of `memory_id`'s
 *  lineage. Returns `memory_id` itself when nothing live replaces it. */
export const currentVersionOf = async (
  store: Pick<UserMemoryStore, 'replacementsOf'>,
  forgotten: ReadonlySet<string>,
  memory_id: string,
): Promise<string> => {
  let id = memory_id;
  const seen = new Set([id]);
  for (let step = 0; step < MAX_LINEAGE; step += 1) {
    const next = await liveReplacementOf(store, forgotten, id);
    if (next === undefined || seen.has(next.memory_id)) return id;
    seen.add(next.memory_id);
    id = next.memory_id;
  }
  return id;
};

/** D-198 §13 — the owner's own version in place of a REVOKED note's claim, if they
 *  wrote one (they may mark an agent's note wrong and replace it with theirs) and it
 *  stands. `head` is the note the owner revoked, `revoke_of` on any of its versions. */
export const ownersVersionOf = async (
  store: Pick<UserMemoryStore, 'getRow' | 'replacementsOf'>,
  forgotten: ReadonlySet<string>,
  head: string,
): Promise<string | undefined> => {
  const current = await currentVersionOf(store, forgotten, head);
  return current !== head && (await store.getRow(current))?.origin_actor === 'user_self'
    ? current
    : undefined;
};

/** Why an agent may not revise an entry, in words it can act on. */
export type OwnEntryRefusal =
  | 'not_found'
  | 'not_an_agent_entry'
  | 'other_author'
  | 'forgotten';

export type OwnEntryCheck =
  | { ok: true; row: UserMemoryRow }
  | { ok: false; refusal: OwnEntryRefusal; message: string };

/** Is `memory_id` a live entry that `author` wrote? `author` undefined (a source
 *  that names no author) owns nothing. */
export const checkOwnEntry = async (
  store: Pick<UserMemoryStore, 'getRow'>,
  forgotten: ReadonlySet<string>,
  memory_id: string,
  author: string | undefined,
): Promise<OwnEntryCheck> => {
  const row = await store.getRow(memory_id);
  if (row === null) {
    return { ok: false, refusal: 'not_found', message: `no memory with id '${memory_id}'` };
  }
  if (row.origin_actor !== 'contracted_user') {
    return {
      ok: false,
      refusal: 'not_an_agent_entry',
      message: `'${memory_id}' is the owner's own entry, which only the owner can change`,
    };
  }
  if (author === undefined || memoryRowAuthor(row) !== author) {
    return {
      ok: false,
      refusal: 'other_author',
      message: `'${memory_id}' was not saved by you, and you can change only entries you saved`,
    };
  }
  if (forgotten.has(memory_id)) {
    return { ok: false, refusal: 'forgotten', message: `'${memory_id}' was forgotten` };
  }
  return { ok: true, row };
};

export type OwnerReplaceCheck =
  | { ok: true; row: UserMemoryRow }
  | { ok: false; refusal: 'not_found' | 'not_replaceable'; message: string };

/** D-198 §12 — may the OWNER replace `memory_id` with their own version? Only a
 *  live, current agent entry: the owner edits their own notes, and a version
 *  already replaced has a newer one to replace instead. The words go to the owner,
 *  so they name the next step and never an id. */
export const checkOwnerReplace = async (
  store: Pick<UserMemoryStore, 'getRow' | 'replacementsOf'>,
  forgotten: ReadonlySet<string>,
  memory_id: string,
): Promise<OwnerReplaceCheck> => {
  const row = await store.getRow(memory_id);
  if (row === null) return { ok: false, refusal: 'not_found', message: 'memory entry not found' };
  if (row.origin_actor === 'user_self') {
    return { ok: false, refusal: 'not_replaceable', message: 'This is your own memory. Edit it instead.' };
  }
  if (row.origin_actor !== 'contracted_user') {
    return { ok: false, refusal: 'not_replaceable', message: 'Only a memory an agent saved can be replaced.' };
  }
  if (forgotten.has(memory_id)) {
    return {
      ok: false,
      refusal: 'not_replaceable',
      message: 'This memory was forgotten. Restore it first, or add a new memory.',
    };
  }
  if ((await currentVersionOf(store, forgotten, memory_id)) !== memory_id) {
    return {
      ok: false,
      refusal: 'not_replaceable',
      message: 'A newer version already replaced this memory. Replace that one instead.',
    };
  }
  return { ok: true, row };
};

/** D-198 §13 — the marks that took an entry OUT of memory (a delete, an agent's forget,
 *  the owner's old hide), without the revokes. A revoked note is out of recall as a
 *  fact like the rest (`forgottenIds` keeps it), but the owner may still replace it with
 *  their own version or delete it, so the owner's own checks use this. */
export const removedIds = async (
  redactions: Collection<MemoryRedactionRecord> | undefined,
): Promise<Set<string>> =>
  redactions
    ? new Set((await redactions.list()).filter((r) => r.revoked !== true).map((r) => r.memory_id))
    : new Set();

export type OwnerRevokeCheck =
  | { ok: true; row: UserMemoryRow }
  | { ok: false; refusal: 'not_found' | 'not_revocable'; message: string };

/** D-198 §13 — may the OWNER mark `memory_id` wrong? Only an agent's note that is live
 *  and current, as for a replace. The words go to the owner. */
export const checkOwnerRevoke = async (
  store: Pick<UserMemoryStore, 'getRow' | 'replacementsOf'>,
  redactions: Collection<MemoryRedactionRecord> | undefined,
  memory_id: string,
): Promise<OwnerRevokeCheck> => {
  const row = await store.getRow(memory_id);
  if (row === null) return { ok: false, refusal: 'not_found', message: 'memory entry not found' };
  if (row.origin_actor === 'user_self') {
    return { ok: false, refusal: 'not_revocable', message: 'This is your own memory. Edit or delete it instead.' };
  }
  if (row.origin_actor !== 'contracted_user') {
    return { ok: false, refusal: 'not_revocable', message: 'Only a memory an agent saved can be revoked.' };
  }
  const mark = redactions ? await redactions.get(memory_id) : null;
  if (mark?.revoked === true) {
    return { ok: false, refusal: 'not_revocable', message: 'You already revoked this memory.' };
  }
  if (mark !== null) {
    return { ok: false, refusal: 'not_revocable', message: 'This memory was removed, so there is nothing to revoke.' };
  }
  if ((await currentVersionOf(store, await forgottenIds(redactions), memory_id)) !== memory_id) {
    return {
      ok: false,
      refusal: 'not_revocable',
      message: 'A newer version already replaced this memory. Revoke that one instead.',
    };
  }
  return { ok: true, row };
};

/** D-198 §13 — mark `head` and every earlier version it replaced WRONG, under one
 *  revoke (`revoke_of`), so revoking the current wording never makes an older one
 *  current again. A version already under the overlay keeps its own mark. */
export const revokeAgentNote = async (input: {
  store: Pick<UserMemoryStore, 'getRow'>;
  redactions: Collection<MemoryRedactionRecord>;
  head: UserMemoryRow;
  now: number;
}): Promise<number> => {
  let versions = 0;
  for (const row of await lineageBackFrom(input.store, input.head)) {
    if ((await input.redactions.get(row.memory_id)) !== null) continue;
    await input.redactions.set(row.memory_id, {
      memory_id: row.memory_id,
      redacted_at: input.now,
      revoked: true,
      revoke_of: input.head.memory_id,
    });
    versions += 1;
  }
  return versions;
};

/** D-198 §13 — lift one revoke: every mark it wrote, so the note and its earlier
 *  versions are as they were. `memory_id` may be the revoked entry or any version
 *  revoked with it. 0 when it is not revoked. */
export const unrevokeAgentNote = async (
  redactions: Collection<MemoryRedactionRecord>,
  memory_id: string,
): Promise<number> => {
  const mark = await redactions.get(memory_id);
  if (mark === null || mark.revoked !== true) return 0;
  const head = mark.revoke_of ?? memory_id;
  const marks = (await redactions.list()).filter(
    (r) => r.revoked === true && (r.revoke_of ?? r.memory_id) === head,
  );
  for (const r of marks) await redactions.delete(r.memory_id);
  return marks.length;
};

/** D-198 §13 — words a claim can use for one another, each read as the word it maps to:
 *  "is named Mia", "her name is Mia", "their names are Mia and Leo" and "is known as Mia"
 *  state what "is called Mia" does. A closed list, chosen by hand: a word belongs here
 *  only if it says the same thing in any note, which no looser test can promise ("called
 *  Maya" is one word from "called Mia", and is the owner's correction).
 *  A key may be two words. "known as" is one, because "as" alone is a stopword, so the
 *  pair is read before the stopwords go; "known" alone is not folded ("known for her
 *  cooking").
 *  ⚠ "called" can also mean phoned, so "Ana called Bob" and "Ana named Bob" are one claim
 *  to it. A wrong match costs one question: a save refused with a way round, or the
 *  Delete confirm offering Mark it wrong. */
const SAME_CLAIM_WORDS: ReadonlyMap<string, string> = new Map([
  ['named', 'called'],
  ['name', 'called'],
  ['names', 'called'],
  ['known as', 'called'],
]);

const claimTokens = (text: string): string[] => {
  const all = tokenizeFtsQuery(text).all;
  const tokens: string[] = [];
  for (let i = 0; i < all.length; i += 1) {
    const word = all[i]!;
    const phrase = i + 1 < all.length ? SAME_CLAIM_WORDS.get(`${word} ${all[i + 1]}`) : undefined;
    if (phrase !== undefined) {
      tokens.push(phrase);
      i += 1;
    } else if (!FTS_STOPWORDS.has(word)) {
      tokens.push(SAME_CLAIM_WORDS.get(word) ?? word);
    }
  }
  return tokens;
};

/** D-198 §13 — a text's content words, the words the claim tests compare. */
export const claimWords = (text: string): Set<string> => new Set(claimTokens(text));

/** D-198 §13 — a note's claim words: its summary's and its body's (a long body's preview). */
export const noteClaimWords = (
  row: Pick<UserMemoryRow, 'summary' | 'body_inline' | 'body_preview'>,
): Set<string> => claimWords(`${row.summary ?? ''} ${row.body_inline ?? row.body_preview ?? ''}`);

/** D-198 §13 — does `words` (`claimWords`) hold every content word of `claim`, two at
 *  least? Then it states that claim, perhaps with more around it. One word in common says
 *  nothing about a claim. */
export const coversClaim = (claim: string, words: ReadonlySet<string>): boolean => {
  const tokens = claimTokens(claim);
  return tokens.length >= 2 && tokens.every((w) => words.has(w));
};

export interface RevokedClaimMatch {
  memory_id: string;
  /** The revoked note's own words, quoted back to the agent. */
  summary: string;
  revoked_at: number;
}

/** D-198 §13 — does a new save restate a claim the owner REVOKED? Matched against
 *  revoked notes only, by their words, both ways round:
 *    - the save's words are all in a revoked note: the memory search, at its exact or
 *      relaxed rung (a loose rung only shares some words, so it never counts);
 *    - a revoked note's content words are all in the save: the same claim restated
 *      with more around it, which the search cannot see from the save's side.
 *  Both are asked of the claim words too (`claimWords`), which read every naming word in
 *  `SAME_CLAIM_WORDS` as "called": the search reads each word as it is spelled.
 *
 *  ⛔ No meaning match yet. An embedding threshold loose enough to catch a
 *  paraphrase also catches other notes about the same person, and none has been
 *  measured. A miss behaves as before: the save is held for the owner's approval
 *  anyway, unless a standing rule lets it run. A wrong match costs one question. */
export const matchRevokedClaim = async (
  store: Pick<UserMemoryStore, 'getRow' | 'search'>,
  redactions: Collection<MemoryRedactionRecord> | undefined,
  text: string,
): Promise<RevokedClaimMatch | undefined> => {
  if (redactions === undefined) return undefined;
  const revoked = new Map(
    (await redactions.list()).filter((r) => r.revoked === true).map((r) => [r.memory_id, r]),
  );
  if (revoked.size === 0) return undefined;
  const matchOf = async (memory_id: string): Promise<RevokedClaimMatch | undefined> => {
    const row = await store.getRow(memory_id);
    const mark = revoked.get(memory_id);
    return row === null || mark === undefined
      ? undefined
      : { memory_id, summary: row.summary ?? row.body_preview ?? '', revoked_at: mark.redacted_at };
  };
  const searched = await store.search(text, 20);
  if (searched.match === 'exact' || searched.match === 'relaxed') {
    const hit = searched.hits.find((h) => revoked.has(h.memory_id));
    if (hit !== undefined) return matchOf(hit.memory_id);
  }
  const saved = claimWords(text);
  for (const memory_id of revoked.keys()) {
    const row = await store.getRow(memory_id);
    if (row === null) continue;
    if (coversClaim(row.summary ?? '', saved) || coversClaim(text, noteClaimWords(row))) {
      return matchOf(memory_id);
    }
  }
  return undefined;
};

/** One revision at a time per store: a replace or forget reads, checks, then
 *  writes, and two calls batched into one turn must not both pass the check on
 *  the same entry. In-process is the whole scope — one server owns its pool. */
const revisionTails = new WeakMap<object, Promise<void>>();
export const withRevisionLock = <T>(store: object, fn: () => Promise<T>): Promise<T> => {
  const prior = revisionTails.get(store) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  revisionTails.set(store, run.then(() => undefined, () => undefined));
  return run;
};

/** The entry and the earlier versions it replaced, newest first, staying within
 *  one author (a lineage is one author's by construction; this only guards). */
export const lineageBackFrom = async (
  store: Pick<UserMemoryStore, 'getRow'>,
  head: UserMemoryRow,
): Promise<UserMemoryRow[]> => {
  const author = memoryRowAuthor(head);
  const lineage: UserMemoryRow[] = [];
  const seen = new Set<string>();
  let row: UserMemoryRow | null = head;
  while (row !== null && !seen.has(row.memory_id) && lineage.length < MAX_LINEAGE) {
    seen.add(row.memory_id);
    lineage.push(row);
    if (row.replaces === undefined) break;
    const prior: UserMemoryRow | null = await store.getRow(row.replaces);
    row = prior !== null && memoryRowAuthor(prior) === author ? prior : null;
  }
  return lineage;
};

export interface ForgetOwnEntryResult {
  memory_id: string;
  /** True once the entry is out of recall, including when it already was. */
  forgotten: true;
  /** How many versions this call put under the overlay (0 when already forgotten). */
  versions: number;
  /** Present when the entry was already forgotten before this call. */
  already?: true;
}

/** What a forget checks before it marks anything: why it is refused, or the entry it
 *  would forget (`already` when that entry is out of recall already). */
export type ForgetOwnEntryCheck =
  | { ok: false; message: string }
  | { ok: true; already: true }
  | { ok: true; already?: undefined; row: UserMemoryRow; forgotten: ReadonlySet<string> };

/** D-329 — the checks of {@link forgetOwnEntry}, which runs them, and so does
 *  `memory.forget`'s check before the owner is asked: the check and the forget cannot
 *  disagree. */
export const checkForgetOwnEntry = async (input: {
  store: Pick<UserMemoryStore, 'getRow'>;
  redactions: Collection<MemoryRedactionRecord>;
  memory_id: string;
  author: string | undefined;
}): Promise<ForgetOwnEntryCheck> => {
  const forgotten = await forgottenIds(input.redactions);
  const check = await checkOwnEntry(input.store, forgotten, input.memory_id, input.author);
  if (check.ok) return { ok: true, row: check.row, forgotten };
  return check.refusal === 'forgotten' ? { ok: true, already: true } : { ok: false, message: check.message };
};

/** Forget `memory_id` and every earlier version it replaced, for `author`. A
 *  version that is already under the overlay keeps its existing record — the
 *  owner's redaction is never overwritten by an agent's forget. */
export const forgetOwnEntry = async (input: {
  store: Pick<UserMemoryStore, 'getRow'>;
  redactions: Collection<MemoryRedactionRecord>;
  memory_id: string;
  author: string | undefined;
  reason?: string;
  now: number;
}): Promise<{ ok: true; result: ForgetOwnEntryResult } | { ok: false; message: string }> => {
  const checked = await checkForgetOwnEntry(input);
  if (!checked.ok) return { ok: false, message: checked.message };
  if (checked.already) {
    return {
      ok: true,
      result: { memory_id: input.memory_id, forgotten: true, versions: 0, already: true },
    };
  }
  let versions = 0;
  for (const row of await lineageBackFrom(input.store, checked.row)) {
    if (checked.forgotten.has(row.memory_id)) continue;
    await input.redactions.set(row.memory_id, {
      memory_id: row.memory_id,
      redacted_at: input.now,
      by_contract_id: input.author!,
      forget_of: checked.row.memory_id,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
    versions += 1;
  }
  return { ok: true, result: { memory_id: input.memory_id, forgotten: true, versions } };
};

/** D-198 §13 — matches a note id inside a stored chat row (`umem_` + a UUID). */
export const MEMORY_ID_IN_TEXT = /\bumem_[A-Za-z0-9_-]+/g;

/** D-198 §13 — where each named note stands NOW, for a past `memory.*` chat row a
 *  model meets again through recall. One line per note that CHANGED since — its
 *  END state through the lineage, never the steps — and none for a note still
 *  current, so a row whose notes all hold carries nothing.
 *
 *  ⛔ "Removed" covers the owner's delete and an agent's forget alike, and says
 *  nothing about saving it again: a delete is neutral (§13), so the line must not
 *  read as a rule. A revoke (a different act) will get its own words. */
export const describeMemoryNow = async (
  store: Pick<UserMemoryStore, 'getRow' | 'replacementsOf'>,
  redactions: Collection<MemoryRedactionRecord> | undefined,
  ids: readonly string[],
): Promise<Map<string, string>> => {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const marks = new Map((redactions ? await redactions.list() : []).map((r) => [r.memory_id, r]));
  const removed = new Set(marks.keys());
  for (const id of new Set(ids)) {
    const mark = marks.get(id);
    // A revoke is the one removal that IS a rule: the owner said it is wrong.
    if (mark?.revoked === true) {
      const on = new Date(mark.redacted_at).toISOString().slice(0, 10);
      const owners = await ownersVersionOf(store, removed, mark.revoke_of ?? id);
      out.set(id, owners === undefined
        ? `${id}: the owner marked it wrong on ${on}. Don't rely on it; ask before saving it again.`
        : `${id}: the owner marked it wrong on ${on} and replaced it with their own version, ${owners}.`);
      continue;
    }
    if (mark !== undefined) {
      out.set(id, `${id}: no longer in memory (removed ${new Date(mark.redacted_at).toISOString().slice(0, 10)}).`);
      continue;
    }
    if ((await store.getRow(id)) === null) {
      // Only the owner's own notes are hard-deleted, so there is no row to date it by.
      out.set(id, `${id}: no longer in memory.`);
      continue;
    }
    const current = await currentVersionOf(store, removed, id);
    if (current === id) continue;
    out.set(id, (await store.getRow(current))?.origin_actor === 'user_self'
      ? `${id}: the owner replaced it with their own version, ${current}.`
      : `${id}: a newer version replaced it, ${current}.`);
  }
  return out;
};

/** Undo an agent's forget (owner only): delete every overlay mark that forget
 *  wrote. `memory_id` may be the forgotten entry or any version forgotten with
 *  it. Returns how many marks went; 0 when no agent forgot that entry. The
 *  owner's own redactions carry no `by_contract_id` and are never touched. */
export const restoreAgentForget = async (
  redactions: Collection<MemoryRedactionRecord>,
  memory_id: string,
): Promise<number> => {
  const mark = await redactions.get(memory_id);
  if (mark === null || mark.by_contract_id === undefined) return 0;
  const head = mark.forget_of ?? memory_id;
  const marks = (await redactions.list()).filter(
    (r) => r.by_contract_id !== undefined && (r.forget_of ?? r.memory_id) === head,
  );
  for (const r of marks) await redactions.delete(r.memory_id);
  return marks.length;
};
