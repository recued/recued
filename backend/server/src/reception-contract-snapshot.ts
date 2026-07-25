/** D-207 slice 1b — the reception door's `ContractSnapshot`.
 *
 *  ## Why this is not optional
 *
 *  The moment a `(reception, anonymous)` source carries a `contract_id`, it becomes a
 *  CONTRACT-BEARING source — and `evaluatePreflightAdmission` THROWS for a
 *  contract-bearing source with no snapshot ("the host must resolve it before dispatch").
 *  So "just put the contract_id on the source" fails closed rather than working. This
 *  builder is what makes the door dispatch at all.
 *
 *  ## The two axes it completes
 *
 *  A door is gated on two independent things, and the snapshot is only ONE of them:
 *
 *    - the **grant** axis (`contract_grant` rows → `isOpGranted`) — the door's OPERATION
 *      authority. Handled by the mint (`mintDoorContract`), floored by
 *      `PUBLIC_CONTRACT_ID`.
 *    - the **tool** axis (`ContractSnapshot.allowed_tools` → `admitContractToolAccess`) —
 *      the door's INGREDIENT authority. Handled here. It is NOT redundant with the grant
 *      axis: `op-admission-gate`'s own comment notes it is PERMISSIVE for a wildcard door,
 *      "its real gate is the per-token `ContractSnapshot.allowed_tools`".
 *
 *  Both must be right, or the door leaks on the axis you forgot.
 *
 *  ## Fail-closed on a dead door — the kill-switch
 *
 *  Mirrors `buildMcpContractSnapshot`'s D-166 P2 rule verbatim: a source bound to a
 *  contract that is no longer live (revoked / expired / deleted) authorizes NOTHING —
 *  `allowed_tools` collapses to EMPTY, so every dispatch is denied
 *  (`tool_not_in_contract`). That is what makes deleting the door contract a live
 *  kill-switch over a form that is already public and already receiving traffic.
 *
 *  It composes with the §5.1 floor: a dead door loses its TOOLS here, and its OPS fall to
 *  `PUBLIC_CONTRACT_ID` (which grants nothing) in `resolveGrantGoverningContractId`. Two
 *  axes, two fences, both closed. Neither is load-bearing alone.
 *
 *  Spec: D-207 §5.1 / §5.3. */

import { isContractActive, type ContractSnapshot, type ExecutionSource } from '@recued/contracts';

import { buildVersionedContractSnapshot } from './contract-snapshot-version.js';
import type { ContractDefinitionStore } from './storage/contract-definition-store.js';

export interface ReceptionContractSnapshotDeps {
  readonly definitionStore: ContractDefinitionStore;
  /** The door's tool allowlist — the recipe's derived `ingredient_ids`
   *  (`deriveRecipeCapability`). The SAME derivation the mint writes its grant rows
   *  from, so the two axes can never disagree about what the door may do. */
  readonly allowedTools: (contractId: string) => readonly string[];
  readonly now: () => number;
}

/** Build the snapshot for a reception dispatch, or fail closed.
 *
 *  Throws only on a source that is not a contract-bearing reception dispatch — that is a
 *  wiring bug, not a runtime condition, and must not be swallowed. Every RUNTIME failure
 *  (dead door, unknown door, no tools) resolves to an EMPTY allowlist, which denies. */
export const buildReceptionContractSnapshot = (
  source: ExecutionSource,
  deps: ReceptionContractSnapshotDeps,
): ContractSnapshot => {
  if (source.channel !== 'reception' || source.actor !== 'anonymous') {
    throw new Error(
      `D-207 buildReceptionContractSnapshot: expected (channel: 'reception', actor: 'anonymous'); got (${source.channel}, ${source.actor}).`,
    );
  }
  const contractId = (source as { contract_id?: unknown }).contract_id;
  if (typeof contractId !== 'string' || contractId.length === 0) {
    throw new Error(
      'D-207 buildReceptionContractSnapshot: the source carries no contract_id — the handler must resolve reception_id → pair → recipe → contract_id before dispatch.',
    );
  }

  const resolvedAt = deps.now();
  const def = deps.definitionStore.get(contractId);
  const live = def !== null && isContractActive(def, resolvedAt);

  // A dead / revoked / deleted door authorizes NOTHING. `allowed_tools: []` denies every
  // dispatch (`tool_not_in_contract`) — the live kill-switch over an already-public form.
  const allowed_tools = live ? [...deps.allowedTools(contractId)] : [];

  return buildVersionedContractSnapshot({
    contract_id: contractId,
    allowed_tools,
    approval_required: [],
    scope_restrictions: [],
    resolved_at: resolvedAt,
  });
};
