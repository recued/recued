/** D-327 — the server half of "one agreement, one key, one gate".
 *
 *  An agreement whose `key_authority` is `'contract'` is its key's WHOLE
 *  authority. Three places need to know that, and all three read it here:
 *    - the token store, which hands every reader the key's checklist computed
 *      from the agreement's grant rows ({@link KeyAgreementLookup.resolveKeyChecklist});
 *    - the key rpcs, which refuse to give such a key a second answer of its own
 *      ({@link KeyAgreementLookup.keyAgreement});
 *    - `contract.grant.write`, which runs issuance's grant check on the agreement
 *      row the key reads ({@link checkAgreementKeyGrant}).
 *
 *  The agreement's deny-by-default lives in `usesExplicitOnlyGrantDefaults`
 *  (`op-admission-gate.ts`), beside the other explicit-only contracts. */

import {
  isContractActive,
  isKeyAuthorityContract,
  keyChecklistFromAgreementGrants,
  keyGrantCheckName,
} from '@recued/contracts';

import type { ContractDefinitionStore } from './storage/contract-definition-store.js';
import type { ContractGrantEntryStore } from './storage/contract-grant-entry-store.js';

export interface KeyAgreementLookup {
  /** The checklist a key bound to `contract_id` reads, or `null` when that
   *  contract is not its key's whole authority (the key keeps its stored
   *  checklist). Read live: a grant switched on or off reaches the key's next
   *  request. */
  resolveKeyChecklist(contract_id: string): Readonly<Record<string, boolean>> | null;
  /** Whether `contract_id` is an agreement that is its key's whole authority,
   *  and whether it can still admit anything; `null` when it is not one. */
  keyAgreement(contract_id: string): { readonly live: boolean } | null;
}

export const createKeyAgreementLookup = (deps: {
  readonly definitions: Pick<ContractDefinitionStore, 'get'>;
  readonly grants: Pick<ContractGrantEntryStore, 'listForContract'>;
  readonly now?: () => number;
}): KeyAgreementLookup => {
  const now = deps.now ?? Date.now;
  return {
    resolveKeyChecklist(contract_id) {
      if (!isKeyAuthorityContract(deps.definitions.get(contract_id))) return null;
      return keyChecklistFromAgreementGrants(deps.grants.listForContract(contract_id));
    },
    keyAgreement(contract_id) {
      const def = deps.definitions.get(contract_id);
      if (def === null || !isKeyAuthorityContract(def)) return null;
      return { live: isContractActive(def, now()) };
    },
  };
};

/** Judge a GRANT before `contract.grant.write` stores it. Returns for every
 *  contract that is not its key's whole authority, and for every row the
 *  issuance check has nothing to say about; otherwise runs that check and lets
 *  it throw with its reason.
 *
 *  ⛔ FAILS CLOSED without the check. An agreement row a key will read is not
 *  written unchecked because the chat deps that own the check are not composed
 *  yet — the owner is told to retry instead. */
export const checkAgreementKeyGrant = (
  deps: {
    readonly definitions: Pick<ContractDefinitionStore, 'get'>;
    readonly preflight: ((toolName: string) => void) | undefined;
  },
  contract_id: string,
  entry_key: string,
): void => {
  if (!isKeyAuthorityContract(deps.definitions.get(contract_id))) return;
  const name = keyGrantCheckName(entry_key);
  if (name === undefined) return;
  if (deps.preflight === undefined) {
    throw new Error(
      `'${name}' cannot be checked for a contract's key right now — try again once the server has finished starting`,
    );
  }
  deps.preflight(name);
};
