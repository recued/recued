/** D-198 §13 — how many times an agent saved the claim of a note the owner is about to
 *  delete: the count behind the Delete confirm's "An agent has saved this 3 times. Mark it
 *  wrong so it asks you first?" (`memory.saves`).
 *
 *  A delete is neutral: an agent may save the same thing again freely, so one that keeps
 *  saving what the owner keeps deleting keeps doing it. Only the owner can see that, and
 *  this count is how they see it. The confirm then offers Revoke, after which a save of
 *  the claim is refused, and made only with the owner's say-so.
 *
 *  Counted: the note, and each earlier save of its claim that no longer stands, whoever
 *  removed it (deleted, forgotten, hidden or revoked). A copy still in memory stands, so it
 *  is not counted. "Its claim" is the Revoke match's word test, made symmetric
 *  (`sameClaim`): one's summary words, two at least, all among the other's words, with
 *  each naming word in `SAME_CLAIM_WORDS` read as "called" (`claimWords`). D-336 slice B:
 *  or an equal claim key, which states one claim in any wording or language. A deleted
 *  save's key is worked out again from the claim its chat records (`claimKeyOf`).
 *
 *  ⛔ A DELETED NOTE'S WORDS ARE NOT IN MEMORY. Delete erased them. The chat the note was
 *  saved in still has them (Delete keeps the chat), in the save: its call row, or the
 *  approval card of a save held for the owner (D-329), which writes no call row. Neither
 *  says which note the save made. So in each such chat the saves are matched up by what is
 *  known: a save restating the claim belongs to a note from that chat that still holds
 *  words restating it, one save each, and the rest belong to its deleted notes, never more
 *  of them than were deleted there.
 *
 *  ⚠ A LOWER BOUND. A save with no record the server can read is not counted: an AI app's
 *  (its calls are not chat rows), one whose chat was deleted, any chat while the vault is
 *  locked. So the prompt can fail to appear, but never counts a save that did not happen. */

import type { ChatMessage, ChatPlanRecord } from '@recued/contracts';
import type { planApproval } from '@recued/gateway';
import type { Collection } from '@recued/storage';
import { toolCallArgsFromRow } from './chat-tool-row.js';
import type { MemoryRedactionRecord } from './memory-rpc-handler.js';
import { claimKeyOfCall } from './memory-claim.js';
import { claimWords, coversClaim, memoryRowAuthor, noteClaimWords } from './memory-revision.js';
import { claimKeysAlike, type UserMemoryRow, type UserMemoryStore } from './user-memory-store.js';

/** One agent save a chat records: the words `memory.write` was called with. */
export interface ChatSave {
  summary: string;
  body?: string;
  /** D-336 — the call's `claim` as it wrote it, for the count to work out its key. */
  claim?: unknown;
}

/** The saves each chat records, by session id. A chat that could not be read is absent. */
export type ChatSavesReader = (
  session_ids: readonly string[],
) => Promise<ReadonlyMap<string, readonly ChatSave[]>>;

const MEMORY_WRITE = 'memory.write';

/** A save's words, as `memory.write` reads them: a summary, trimmed, a body, and the
 *  claim the call carried. */
const saveOf = (args: unknown): ChatSave | undefined => {
  if (args === null || typeof args !== 'object') return undefined;
  const { summary, body, claim } = args as { summary?: unknown; body?: unknown; claim?: unknown };
  if (typeof summary !== 'string' || summary.trim().length === 0) return undefined;
  return {
    summary: summary.trim(),
    ...(typeof body === 'string' && body.length > 0 ? { body } : {}),
    ...(claim !== undefined && claim !== null ? { claim } : {}),
  };
};

/** The saves a chat's rows record: each `memory.write` call that ran and succeeded. */
export const savesInMessages = (messages: readonly ChatMessage[]): ChatSave[] =>
  messages.flatMap((m) => {
    if (m.role !== 'tool' || m.tool_call?.state !== 'succeeded') return [];
    const save = saveOf(toolCallArgsFromRow(m.content, MEMORY_WRITE));
    return save === undefined ? [] : [save];
  });

/** The saves a chat's approval cards record: each `memory.write` held for the owner that
 *  then ran. A card with no hold was spent by the call made again, whose row records it. */
export const savesOnCards = (records: readonly ChatPlanRecord[]): ChatSave[] =>
  records.flatMap((r) => {
    if (r.plan.tool !== MEMORY_WRITE || r.plan.hold === undefined) return [];
    if (r.execution?.status !== 'completed') return [];
    const save = saveOf(r.plan.args);
    return save === undefined ? [] : [save];
  });

/** Reads the saves each chat records, from its rows and its approval cards. */
export const createChatSavesReader = (deps: {
  chatStore: { listMessages(session_id: string): Promise<ChatMessage[]> };
  plans?: Pick<planApproval.PlanApprovalStore, 'listForSession'>;
}): ChatSavesReader => async (session_ids) => {
  const out = new Map<string, readonly ChatSave[]>();
  for (const session_id of new Set(session_ids)) {
    try {
      const [messages, cards] = await Promise.all([
        deps.chatStore.listMessages(session_id),
        deps.plans?.listForSession?.(session_id) ?? [],
      ]);
      out.set(session_id, [...savesInMessages(messages), ...savesOnCards(cards)]);
    } catch {
      // A chat it cannot read (the vault is locked) has no saves to count.
    }
  }
  return out;
};

/** What a note or a save claims: its summary, every word it holds, and its claim key
 *  when it was saved with a claim (D-336). */
interface ClaimText {
  summary: string;
  words: ReadonlySet<string>;
  key?: string;
}

const claimTextOf = (summary: string, body?: string, key?: string): ClaimText => ({
  summary,
  words: claimWords(body === undefined ? summary : `${summary} ${body}`),
  ...(key !== undefined ? { key } : {}),
});

/** Two notes, or a note and a save, state the same claim: their claim keys are equal, or
 *  either one's summary is all in the other's words. An equal key adds a match and never
 *  removes one (D-336 §3.4). The Revoke match asks the word index as well; this asks
 *  none, because a deleted note's words are in none. */
const sameClaim = (a: ClaimText, b: ClaimText, keysAlike: (x: string, y: string) => boolean = (x, y) => x === y): boolean =>
  (a.key !== undefined && b.key !== undefined && keysAlike(a.key, b.key))
  || coversClaim(a.summary, b.words) || coversClaim(b.summary, a.words);

/** A note's claim, while it still holds its words. */
const noteClaim = (row: UserMemoryRow): ClaimText | undefined =>
  row.summary === undefined || row.summary.length === 0
    ? undefined
    : {
        summary: row.summary,
        words: noteClaimWords(row),
        ...(row.claim_key !== undefined ? { key: row.claim_key } : {}),
      };

const isAgentNote = (row: UserMemoryRow | null): row is UserMemoryRow =>
  row !== null && row.origin_actor === 'contracted_user';

export interface MemorySaveCount {
  /** The note and each earlier save of its claim that no longer stands. */
  saves: number;
  /** How many different agents made them, as far as their notes say; at least 1. */
  agents: number;
}

/** How many times an agent saved `note`'s claim. `note` is an agent's note in memory,
 *  under no mark (`memory.saves` refuses any other). */
export const countAgentSaves = async (input: {
  store: Pick<UserMemoryStore, 'getRow' | 'listSession'> & Partial<Pick<UserMemoryStore, 'claimEndsLike'>>;
  redactions: Collection<MemoryRedactionRecord> | undefined;
  readChatSaves?: ChatSavesReader;
  /** D-336 slice B — the key a chat-recorded save's claim made (`claimKeyOfCall`, with the
   *  owner's lookups for a linked end). Absent → only a claim of words and "owner" keys. */
  claimKeyOf?: (claim: unknown) => string | undefined;
  note: UserMemoryRow;
}): Promise<MemorySaveCount> => {
  const { store, note } = input;
  const keyOf = input.claimKeyOf ?? ((claim: unknown) => claimKeyOfCall(claim));
  // Audit 2026-11-01 — a merged contact's saves name it by its own id.
  const keysAlike = claimKeysAlike(store);
  const claim = noteClaim(note);
  if (claim === undefined) return { saves: 1, agents: 1 };
  const authors = new Set<string>();
  const madeBy = (row: UserMemoryRow): void => {
    const author = memoryRowAuthor(row);
    if (author !== undefined) authors.add(author);
  };
  madeBy(note);
  let saves = 1;

  // Removed notes: one still holding its words is matched here; a deleted one is
  // matched through the chat it was saved in, below.
  const deletedFrom = new Map<string, UserMemoryRow[]>();
  for (const mark of input.redactions ? await input.redactions.list() : []) {
    const row = await store.getRow(mark.memory_id);
    if (!isAgentNote(row)) continue;
    if (mark.deleted === true) {
      const chat = row.channel_session_id;
      if (chat !== undefined) deletedFrom.set(chat, [...(deletedFrom.get(chat) ?? []), row]);
      continue;
    }
    const other = noteClaim(row);
    if (other !== undefined && sameClaim(claim, other, keysAlike)) {
      saves += 1;
      madeBy(row);
    }
  }
  if (deletedFrom.size === 0 || input.readChatSaves === undefined) {
    return { saves, agents: Math.max(authors.size, 1) };
  }

  let recorded: ReadonlyMap<string, readonly ChatSave[]>;
  try {
    recorded = await input.readChatSaves([...deletedFrom.keys()]);
  } catch {
    recorded = new Map();
  }
  for (const [chat, deleted] of deletedFrom) {
    const chatSaves = recorded.get(chat);
    if (chatSaves === undefined) continue;
    const restating = chatSaves
      .filter((save) => sameClaim(claim, claimTextOf(save.summary, save.body, keyOf(save.claim)), keysAlike)).length;
    // Each note from this chat still holding words that restate the claim made one of
    // those saves: this note, a live copy, an earlier version, a forgotten one.
    const held = (await store.listSession(chat)).filter((row) => {
      const other = noteClaim(row);
      return other !== undefined && sameClaim(claim, other, keysAlike);
    }).length;
    const ofDeleted = Math.min(Math.max(restating - held, 0), deleted.length);
    if (ofDeleted > 0) {
      saves += ofDeleted;
      // A chat that records its saves is the owner's, one agent's, so its deleted
      // notes all name who made them.
      deleted.forEach(madeBy);
    }
  }
  return { saves, agents: Math.max(authors.size, 1) };
};
