/** D-213 Track A / A1 — the owner-only interaction-recall boundary.
 *
 * Interaction recall deliberately has no kernel operation and no grant handle.
 * Its one legal caller is the unrestricted owner on the durable direct-chat
 * surface. The channel check is independent and load-bearing: the shared grant
 * resolver also maps `(messenger, user_self)` to the owner sentinel even though
 * messenger authenticates only a conversation, not its sender. */

import {
  OWNER_CONTRACT_ID,
  isExecutionSource,
  type ExecutionSource,
} from '@recued/contracts';

import { resolveGrantGoverningContractId } from './grant-governing-contract.js';
import {
  CHAT_MESSAGE_RECALL_ELIGIBILITY,
  type ChatMessageRecallEligibility,
} from './storage/chat-store.js';
import type { ContractDefinitionStore } from './storage/contract-definition-store.js';

/** The complete storage scope a caller may receive for launch interaction
 * recall. Holding this value means both the positive owner-principal gate and
 * the row-level eligibility predicate have passed; callers never author it. */
export interface OwnerRecallCorpusScope {
  readonly governing_contract_id: typeof OWNER_CONTRACT_ID;
  readonly row_eligibility:
    typeof CHAT_MESSAGE_RECALL_ELIGIBILITY.OWNER_AUTHENTICATED_CHAT;
  /** The storage discriminant. `null` for the owner corpus, whose rows are
   *  contract-free by construction (`deriveChatMessageRecallEligibility` stamps
   *  `OWNER_AUTHENTICATED_CHAT` only for `user_self` with NO contract). */
  readonly recall_contract_id: null;
}

/** D-166 door corpus — one contracted caller's OWN interaction history.
 *
 *  ⛔⛔ WHY THIS EXISTS. The owner scope above is not the only tenant. When a
 *  seller sells `llm_gateway` access, each customer drives chat under their own
 *  bound door, and their turns are stamped `chat:not_owner_authenticated` — a
 *  bucket that, until this scope, had NO READER AT ALL. Every contracted
 *  caller's history was written and then unreachable, so a customer could not
 *  recall their own prior conversation. Isolating them is the same property the
 *  owner corpus has, applied per tenant: a door sees its own rows and nothing
 *  else.
 *
 *  ⛔ THE ESCALATION FENCE IS INHERITED, NOT RE-DERIVED. `resolveGrant-
 *  GoverningContractId` already rules that an explicit `contract_id` is ALWAYS a
 *  bound door — *"never the owner sentinel, even if it literally equals
 *  `OWNER_CONTRACT_ID` (the owner is derived, never bound)"* — so this asks that
 *  resolver rather than reading `contract_id` off the source. A scope that
 *  compared the raw field itself could be handed `OWNER_CONTRACT_ID` by a door.
 *
 *  ⛔ AND THE CHANNEL FENCE STAYS INDEPENDENT, for the reason the owner scope
 *  states: the grant resolver maps `(messenger, user_self)` to the owner
 *  sentinel even though messenger authenticates a conversation, not its sender.
 *  Both scopes test `channel === 'chat'` on their own. */
export interface ContractRecallCorpusScope {
  /** The live bound door. Never `OWNER_CONTRACT_ID` — see the fence above. */
  readonly governing_contract_id: string;
  readonly row_eligibility:
    typeof CHAT_MESSAGE_RECALL_ELIGIBILITY.UNAUTHENTICATED_CHAT;
  /** ⛔ NEVER NULL. A `null` here would match every legacy row written before
   *  the column existed — the fail-open shape this whole design avoids. */
  readonly recall_contract_id: string;
}

export type RecallCorpusScope =
  | OwnerRecallCorpusScope
  | ContractRecallCorpusScope;

const OWNER_RECALL_SCOPE: OwnerRecallCorpusScope = Object.freeze({
  governing_contract_id: OWNER_CONTRACT_ID,
  row_eligibility:
    CHAT_MESSAGE_RECALL_ELIGIBILITY.OWNER_AUTHENTICATED_CHAT,
  recall_contract_id: null,
});

/** Resolve the launch interaction corpus or fail closed.
 *
 * The direct-chat test happens before the governing-contract resolver so a
 * messenger caller cannot inherit the resolver's owner result. Explicit
 * contracts, contracted/anonymous actors, dead doors, malformed shapes, and
 * missing sources all return `null`. */
export const resolveOwnerRecallCorpusScope = (
  source: unknown,
  definitionStore: ContractDefinitionStore,
  now: () => number = Date.now,
): OwnerRecallCorpusScope | null => {
  if (!isExecutionSource(source) || source.channel !== 'chat') return null;
  if (
    resolveGrantGoverningContractId(
      source as ExecutionSource,
      definitionStore,
      now,
    ) !== OWNER_CONTRACT_ID
  ) {
    return null;
  }
  return OWNER_RECALL_SCOPE;
};

/** Resolve ONE contracted caller's own interaction corpus, or fail closed.
 *
 *  Mirrors {@link resolveOwnerRecallCorpusScope}'s shape deliberately: same
 *  independent channel test, same "ask the grant resolver" rule, same
 *  fail-closed default. It differs in exactly one place — the resolved contract
 *  must be a live BOUND DOOR rather than the owner sentinel.
 *
 *  ⚠ A dead / revoked / deleted door resolves to `undefined` here (the resolver
 *  liveness-gates it) and therefore to `null`. That is the intended lifecycle:
 *  revocation stamps `revoked_at` rather than deleting, and contract ids are
 *  minted fresh and never reused, so a revoked door's rows simply become
 *  unreachable — they are not inherited by anything. */
export const resolveContractRecallCorpusScope = (
  source: unknown,
  definitionStore: ContractDefinitionStore,
  now: () => number = Date.now,
): ContractRecallCorpusScope | null => {
  if (!isExecutionSource(source) || source.channel !== 'chat') return null;
  const governing = resolveGrantGoverningContractId(
    source as ExecutionSource,
    definitionStore,
    now,
  );
  // `undefined` is a dead door or a contract-free non-owner dispatch; the owner
  // sentinel is the other scope's business. Neither may reach a door corpus.
  if (governing === undefined || governing === OWNER_CONTRACT_ID) return null;
  return {
    governing_contract_id: governing,
    row_eligibility: CHAT_MESSAGE_RECALL_ELIGIBILITY.UNAUTHENTICATED_CHAT,
    recall_contract_id: governing,
  };
};

/** Narrow storage-side helper used by the A2 backend. Kept separate from the
 * caller gate so raw strings never become SQL predicates by accident. */
export const isOwnerRecallRowEligibility = (
  value: unknown,
): value is OwnerRecallCorpusScope['row_eligibility'] =>
  value === CHAT_MESSAGE_RECALL_ELIGIBILITY.OWNER_AUTHENTICATED_CHAT;

/** Compile-time assertion that the scope's row discriminator remains a member
 * of the store's closed stamp vocabulary. */
const _scopeStampTypecheck: ChatMessageRecallEligibility =
  OWNER_RECALL_SCOPE.row_eligibility;
void _scopeStampTypecheck;

/** The ONE resolution order for a turn's recall corpus: owner first, then a
 *  door, else null (fail-closed).
 *
 *  ⛔ IT IS A FUNCTION BECAUSE IT HAS TWO CALLERS AND MUST NOT HAVE TWO COPIES.
 *  `chat-recall-search-tool` decides which corpus a SEARCH may read; the packet
 *  pointer block decides which corpus it may ADVERTISE. If those resolve
 *  differently the pointer names rows the search cannot reach -- and a pointer
 *  the tool then fails to honour teaches the model that recall does not work,
 *  which is worse than never pointing at all. */
export const resolveRecallCorpusScopeForSource = (
  source: unknown,
  definitionStore: ContractDefinitionStore,
  now: () => number = Date.now,
): RecallCorpusScope | null =>
  resolveOwnerRecallCorpusScope(source, definitionStore, now)
  ?? resolveContractRecallCorpusScope(source, definitionStore, now);
