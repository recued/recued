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

import {
  contractPermitsDoorType,
  isContractActive,
  type ContractSnapshot,
  type ExecutionSource,
} from '@recued/contracts';

import { buildVersionedContractSnapshot } from './contract-snapshot-version.js';
import type { ContractDefinitionStore } from './storage/contract-definition-store.js';

export interface ReceptionContractSnapshotDeps {
  readonly definitionStore: ContractDefinitionStore;
  /** The door's tool allowlist — the recipe's derived `ingredient_ids`
   *  (`deriveRecipeCapability`). The SAME derivation the mint writes its grant rows
   *  from, so the two axes can never disagree about what the door may do. */
  readonly allowedTools: (contractId: string) => readonly string[];
  /** The ops the owner CONFIRMED at bind — the door's derived capability
   *  closure, the SAME derivation `mintDoorContract` writes its grant rows
   *  from. Read only when the door carries the standing-closure opt-in.
   *
   *  ⛔⛔ REQUIRED, AND THAT IS THE WHOLE POINT. It was optional, on the
   *  reasoning that an absent dep fails closed — which is true, and is exactly
   *  how the feature shipped DEAD: optional meant no caller had to pass it, and
   *  none did, so the opt-in could never reach either gate on any production
   *  path. "Fail closed" described the bug perfectly and therefore hid it.
   *
   *  Required makes "nobody wired it" a COMPILE ERROR instead of a silent
   *  permanent refusal. Same lesson as `ContractSnapshotAuthority`'s `Pick`:
   *  the type is where you say a thing is mandatory, because that is the only
   *  place a missing wiring cannot pass a green test suite. */
  readonly grantedOperations: (contractId: string) => readonly string[];
  readonly now: () => number;
}

/** The door's owner-confirmed operation closure, read from its own stored scope —
 *  the SAME `scope.operation_ids` `mintDoorContract` wrote from the derived
 *  capability, so the closure and the grant rows cannot disagree. Mirrors the
 *  runners' `allowedToolsFor` exactly, one field over.
 *
 *  ⛔⛔ EXPORTED AND SHARED BY ALL THREE RUNNERS, NOT COPIED INTO EACH. This
 *  feature shipped once already with the resolver declared, read, tested — and
 *  wired by NOBODY, because every test supplied its own. A single exported
 *  resolver is what makes "did production wire it" one question instead of
 *  three, and lets the e2e call the same function the runner does rather than
 *  hand one in. */
export const grantedOperationsFor = (
  definitionStore: ContractDefinitionStore,
): ((contractId: string) => readonly string[]) => (contractId) =>
  definitionStore.get(contractId)?.scope?.operation_ids ?? [];

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
  const live = def !== null
    && isContractActive(def, resolvedAt)
    && contractPermitsDoorType(def, 'reception');

  // A dead / revoked / deleted door authorizes NOTHING. `allowed_tools: []` denies every
  // dispatch (`tool_not_in_contract`) — the live kill-switch over an already-public form.
  const allowed_tools = live ? [...deps.allowedTools(contractId)] : [];

  // ⛔ THE OPT-IN IS READ OFF THE LIVE DOOR, and gated on the same `live` check
  // as the tools: a revoked / expired / deleted door authorizes NOTHING on
  // either axis, so deleting the contract stays a true kill-switch rather than
  // leaving a standing closure behind it.
  const standing = live && def?.door_execution_policy?.standing_closure === true
    ? [...deps.grantedOperations(contractId)]
    : undefined;

  return buildVersionedContractSnapshot({
    contract_id: contractId,
    allowed_tools,
    approval_required: [],
    scope_restrictions: [],
    resolved_at: resolvedAt,
    // ⚠ An EMPTY closure is not the same as an absent one and must not be sent
    // as one: a door whose recipe dispatches no ops has nothing to admit, and
    // an empty array reads at the gate as "this op is not in the closure" —
    // correct — where `undefined` would be indistinguishable from "no opt-in".
    ...(standing === undefined ? {} : { standing_closure_operation_ids: standing }),
  });
};
