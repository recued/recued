/** D-186 — the messenger "Active passes" seam.
 *
 *  Lists + early-revokes active session grants (`grant_kind: 'session'`) for the
 *  `/recued passes` live-control surface, through the SAME `contract-handler`
 *  projection helpers (+ the SAME `contract.contract_definition_changed`
 *  broadcast on revoke) the `collection.contract.session_grant.{list,revoke}`
 *  rpc uses — so the messenger surface never drifts from the webclient "Active
 *  passes" bubble. A thin wrapper over the shared contract store (the
 *  established per-composer pattern, mirroring `wire-execute-deps` /
 *  `wire-housekeeping-substrate`); injected into `composeMessengerLiveControl`
 *  as its `passes` seam.
 *
 *  Spec: docs/d-186-spec.md (session grants) + docs/d-181-spec.md § 8
 *  (messenger live-control). */

import type { SessionGrantView } from '@recued/contracts';

import {
  emitContractChanged,
  listActiveSessionGrantViews,
  revokeSessionGrantView,
  type ContractBroadcastEvent,
} from '../../contract-handler.js';
import { createContractDefinitionStore } from '../../storage/contract-definition-store.js';
import type { ContractStore } from '../../storage/contract-store.js';

/** The `passes` seam shape `composeMessengerLiveControl` consumes. */
export interface SessionGrantPassesSeam {
  /** Active session grants, soonest-expiring first (the global owner-wide
   *  bubble). */
  list: () => SessionGrantView[];
  /** Early-revoke one session grant + project the now-`revoked` view, or `null`
   *  when the store fail-closes (absent / non-`'session'` / already-inert).
   *  Fans the contract-changed broadcast on success. */
  revoke: (contract_id: string) => SessionGrantView | null;
}

export interface ComposeSessionGrantPassesDeps {
  /** The shared contract store; the seam wraps it as a contract-definition
   *  store internally. */
  contractStore: ContractStore;
  /** D-121 bus emit for the `contract.contract_definition_changed` fan-out on a
   *  successful revoke — parity with the rpc path. Absent ⇒ no broadcast (the
   *  revoke still persists; only the live fan-out is skipped). */
  broadcast?: (event: ContractBroadcastEvent) => void;
  /** Clock seam (tests). */
  now?: () => number;
}

export const composeSessionGrantPasses = (
  deps: ComposeSessionGrantPassesDeps,
): SessionGrantPassesSeam => {
  const now = deps.now ?? Date.now;
  // Thread the clock into the store too, so `revoked_at` is stamped on the same
  // clock the view is projected against (no-op in production — the store
  // defaults to `Date.now`).
  const definitionStore = createContractDefinitionStore(deps.contractStore, { now });
  return {
    list: () => listActiveSessionGrantViews(definitionStore, now()),
    revoke: (contract_id) => {
      const view = revokeSessionGrantView(definitionStore, contract_id, now());
      // Parity with `session_grant.revoke` (contract-handler emits the same
      // signal AFTER a successful revoke): drop the pass from every paired
      // webclient's "Active passes" list live, not just on next reload.
      // Best-effort — `emitContractChanged` swallows, so a bus throw never
      // escapes into the messenger webhook path.
      if (view !== null) emitContractChanged(deps.broadcast, 'revoke', view.contract_id);
      return view;
    },
  };
};
