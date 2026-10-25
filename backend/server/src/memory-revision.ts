/** D-198 §10 — an agent replaces or forgets its OWN pool entries.
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

import type { Collection } from '@recued/storage';
import type { MemoryRedactionRecord } from './memory-rpc-handler.js';
import type { UserMemoryRow, UserMemoryStore } from './user-memory-store.js';

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
): Promise<Set<string>> =>
  redactions ? new Set((await redactions.list()).map((r) => r.memory_id)) : new Set();

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
  const forgotten = await forgottenIds(input.redactions);
  const check = await checkOwnEntry(input.store, forgotten, input.memory_id, input.author);
  if (!check.ok) {
    if (check.refusal === 'forgotten') {
      return {
        ok: true,
        result: { memory_id: input.memory_id, forgotten: true, versions: 0, already: true },
      };
    }
    return { ok: false, message: check.message };
  }
  let versions = 0;
  for (const row of await lineageBackFrom(input.store, check.row)) {
    if (forgotten.has(row.memory_id)) continue;
    await input.redactions.set(row.memory_id, {
      memory_id: row.memory_id,
      redacted_at: input.now,
      by_contract_id: input.author!,
      forget_of: check.row.memory_id,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
    versions += 1;
  }
  return { ok: true, result: { memory_id: input.memory_id, forgotten: true, versions } };
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
