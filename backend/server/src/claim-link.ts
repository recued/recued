/** D-336 slice Q — a save linked to the contact its turn, or its AI app, added under the same name.
 *
 *  Told "My niece Mia was born on 2 June 2015", an AI adds Mia as a contact and saves "Mia is the
 *  owner's niece" (bench task 416). The save names her in words: the add may not have run yet,
 *  waiting for the owner, and its target_id is not the AI's to know. Each `contact.write` that
 *  adds a contact and each `memory.write` records what it made, as it runs, under where its call
 *  came from (`claimLinkScopeOf`); then each text end of a save there that is the added name
 *  exactly is linked to that contact, whichever ran first. Held or run by a standing rule alike:
 *  both run through the tool's handler.
 *
 *  Where, by the owner's rulings (2026-11-01): a chat's turn ("the same turn, the same name"),
 *  and an AI app, whose calls carry no turn, by its contract at any time ("Same app, any time").
 *  Two contacts one scope added under one name are not told apart, so neither is linked; any
 *  other name stays words, for the owner to link by hand (slice E).
 *
 *  A turn is the reply the owner sees: since D-337 slice K, a call that waits for the owner leaves
 *  the rest of that reply to the turn that carries the conversation on once they answer, so a
 *  turn that carries another on counts as the one it carries on (`rootTurnOf`). Live, the add
 *  was held and the save came after it, in such a turn, and was never linked (bench task 424,
 *  2026-11-02). A messenger chat's held write keeps its turn on its hold, which its source does
 *  not name. */

import {
  listedMemoryRelation,
  memoryClaimEndKey,
  type ChatDispatchContext,
  type ChatPlanMade,
  type MemoryClaimEnd,
} from '@recued/contracts';
import type { Collection } from '@recued/storage';

import type { EventBus } from './events/bus.js';
import { emitMemoryUser } from './events/emit-sites.js';
import { claimContactEmails, type ClaimRecordLookups } from './memory-claim.js';
import { forgottenIds } from './memory-revision.js';
import type { MemoryRedactionRecord } from './memory-rpc-handler.js';
import type { ClaimLinkLedger } from './storage/claim-link-ledger.js';
import type { ContactStore } from './storage/contact-store.js';
import type { UserMemoryStore } from './user-memory-store.js';

export interface ClaimLinkerDeps {
  readonly ledger: () => ClaimLinkLedger | undefined;
  readonly memory: () => Pick<UserMemoryStore, 'getRow' | 'update' | 'listClaimEnd'> | undefined;
  readonly contacts: () => Pick<ContactStore, 'get' | 'resolveCanonicalEmail'> | undefined;
  /** The owner's lookups, which name a linked contact's address for the note's links. */
  readonly ownerRecords: () => ClaimRecordLookups;
  readonly redactions?: () => Collection<MemoryRedactionRecord> | undefined;
  readonly bus?: () => EventBus | undefined;
  readonly now?: () => number;
  /** The turn a continuation's turn carries on, the first of its chain (D-337's turn store);
   *  `undefined` for a turn that carries none on. */
  readonly rootTurnOf?: (turn_id: string) => string | undefined;
}

/** A name as a claim's end holds it (`parseClaimArg`): trimmed, each run of spaces one. */
const nameKey = (words: string): string => words.trim().replace(/\s+/gu, ' ');

/** Where a call came from, as the ledger's scope: its chat's turn, or its AI app. A turn that
 *  carries another on is that other (`rootTurnOf`). None for a call with neither. */
export const claimLinkScopeOf = (
  ctx: Pick<ChatDispatchContext, 'execution_source' | 'session_id' | 'turn_id'>,
  rootTurnOf?: (turn_id: string) => string | undefined,
): string | undefined => {
  const source = ctx.execution_source;
  if (source?.channel === 'mcp') return `app:${source.contract_id}`;
  const session = source?.channel === 'chat' ? source.chat_session_id : ctx.session_id;
  const turn = (source?.channel === 'chat' ? source.turn_id : undefined) ?? ctx.turn_id;
  if (session === undefined || session === '' || turn === undefined || turn === '') return undefined;
  let root: string | undefined;
  try { root = rootTurnOf?.(turn); } catch { /* the turn itself */ }
  return `turn:${session}:${root !== undefined && root !== '' ? root : turn}`;
};

/** Tell the server what a write made (`ChatToolHandlerDeps.onRecordMade`), from the tool's
 *  handler as it runs. A link that fails never fails the write that made the record. */
export const recordMade = async (
  deps: { readonly onRecordMade?: (made: ChatPlanMade, ctx: ChatDispatchContext) => Promise<void> },
  made: ChatPlanMade,
  ctx: ChatDispatchContext,
): Promise<void> => {
  try {
    await deps.onRecordMade?.(made, ctx);
  } catch (error) {
    console.warn('[chat] a save was not linked to the contact its turn or app added', error);
  }
};

export const createClaimLinker = (deps: ClaimLinkerDeps) => {
  const recordMade = async (made: ChatPlanMade, ctx: Pick<ChatDispatchContext, 'execution_source' | 'session_id' | 'turn_id'>): Promise<void> => {
    const scope = claimLinkScopeOf(ctx, deps.rootTurnOf);
    const ledger = deps.ledger();
    const store = deps.memory();
    const contacts = deps.contacts();
    if (scope === undefined || ledger === undefined || store === undefined || contacts === undefined) return;
    ledger.record(scope, made, made.kind === 'contact' ? nameKey(made.name) : undefined, (deps.now ?? Date.now)());

    // The one contact this scope added under these words, as it is now: one given an address
    // since, or merged since, is found from the address it was added under.
    const contactNamed = (words: string): { contact_id: string; name: string } | undefined => {
      const found = new Map<string, { contact_id: string; name: string }>();
      for (const target of ledger.contactsNamed(scope, nameKey(words))) {
        let email = target;
        try { email = contacts.resolveCanonicalEmail(target).canonical_email; } catch { /* a broken chain: the row itself */ }
        const contact = contacts.get(email);
        if (contact === null || contact.contact_id === undefined || contact.merged_into !== undefined) continue;
        const name = contact.name?.trim();
        found.set(contact.contact_id, { contact_id: contact.contact_id, name: name !== undefined && name !== '' ? name : nameKey(words) });
      }
      return found.size === 1 ? [...found.values()][0] : undefined;
    };
    const forgotten = await forgottenIds(deps.redactions?.());
    const linkSave = async (memory_id: string): Promise<void> => {
      if (forgotten.has(memory_id)) return;
      const row = await store.getRow(memory_id);
      if (row === null || row.claim === undefined) return;
      // A contact stands only where the relation takes a person, as a save's own ends are
      // checked; a relation in the owner's own words takes any end (`ownerClaim`).
      const listed = listedMemoryRelation(row.claim.relation);
      const link = (end: MemoryClaimEnd, place: 'subject' | 'object'): MemoryClaimEnd =>
        'text' in end && (listed === undefined || listed[place] === 'person') ? contactNamed(end.text) ?? end : end;
      const subject = link(row.claim.subject, 'subject');
      const object = link(row.claim.object, 'object');
      if (subject === row.claim.subject && object === row.claim.object) return;
      const claim = { ...row.claim, subject, object };
      // As a save naming a contact does: the note is linked to the contact too.
      const provenance = [...new Set([...(row.provenance_entity_ids ?? []), ...claimContactEmails(claim, deps.ownerRecords())])];
      await store.update(memory_id, { claim, provenance_entity_ids: provenance });
      emitMemoryUser(deps.bus?.(), memory_id);
    };

    if (made.kind === 'memory') return linkSave(made.memory_id);
    // A contact added: this scope's saves that name it in words.
    for (const row of await store.listClaimEnd(memoryClaimEndKey({ text: made.name }))) {
      if (ledger.saved(scope, row.memory_id)) await linkSave(row.memory_id);
    }
  };
  return { recordMade };
};
