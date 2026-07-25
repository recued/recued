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
}

const OWNER_RECALL_SCOPE: OwnerRecallCorpusScope = Object.freeze({
  governing_contract_id: OWNER_CONTRACT_ID,
  row_eligibility:
    CHAT_MESSAGE_RECALL_ELIGIBILITY.OWNER_AUTHENTICATED_CHAT,
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
