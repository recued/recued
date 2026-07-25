/** Grant-foundation slice 3 (D-187 AMENDMENT `693b7d03`) — the store-backed grant
 *  resolver: the atomic "is `<entry_key>` granted to `<contract_id>`" lookup the
 *  admission gate (op entries) + the read gate (collection / topic entries) call.
 *
 *  Thin by design — it composes the dumb {@link ContractGrantEntryStore} three-state
 *  read (`true` grant / `false` revoke / `undefined` no-row) with the pure
 *  `resolveGrantEntry(explicit, authorDefault)` rule from `@recued/contracts`. The
 *  caller supplies the per-entry `authorDefault` (it holds the registry / pack context
 *  — pack `default_grants`, kernel standard-toolset, topic `mcp_exposed` hint), exactly
 *  as the obsoleted D-187 S2 resolver took `registryDefault` as an input. CONTRACT
 *  LIVENESS (active / not revoked / grant-kind) is gated UPSTREAM at the overlay
 *  (`policy-contract-overlay.ts`), the same layer that gates the collection read-fence
 *  (`resolveContractScopeRestrictions`) — this resolver is the keyed lookup once the
 *  bound `contract_id` is in hand.
 *
 *  Spec: `docs/d-187-spec.md` AMENDMENT block §3; handover
 *  `handover_grant_foundation_slice3_amended.md`. */

import { resolveGrantEntry } from '@recued/contracts';

import type { ContractGrantEntryStore } from './storage/contract-grant-entry-store.js';

/** The keyed grant lookup the gates call. */
export interface GrantEntryResolver {
  /** Is `entry_key` granted to `contract_id`? The contract's explicit stored
   *  grant/revoke wins; absence falls back to the caller-supplied `authorDefault`
   *  (true=granted-by-author, false=author-private/not-pre-granted). The owner
   *  contract is seeded complete by the boot reconcile, so its lookups always hit an
   *  explicit row; doors fall to `authorDefault` for un-toggled entries. */
  isGranted(contract_id: string, entry_key: string, authorDefault: boolean): boolean;
}

/** Wrap a {@link ContractGrantEntryStore} as the {@link GrantEntryResolver}. Stateless;
 *  safe to construct per request or once at boot (it reads the store live each call). */
export const createGrantEntryResolver = (
  store: ContractGrantEntryStore,
): GrantEntryResolver => ({
  isGranted(contract_id, entry_key, authorDefault) {
    return resolveGrantEntry(store.get(contract_id, entry_key), authorDefault);
  },
});
