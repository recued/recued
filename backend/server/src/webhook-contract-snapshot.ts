/** D-209 #1 W3 — the webhook door's `ContractSnapshot`.
 *
 *  ## Why this is not optional
 *
 *  Same rule as the reception door (`reception-contract-snapshot.ts`): the moment a
 *  `(webhook, anonymous)` source carries a `contract_id`, it becomes a CONTRACT-BEARING
 *  source — and `evaluatePreflightAdmission` / `gateRecipeAgainstPolicy` THROW for a
 *  contract-bearing source with no snapshot ("the host must resolve it before dispatch").
 *  So "just stamp the contract_id on the source" fails closed rather than working. This
 *  builder is what makes the door dispatch at all.
 *
 *  ## The one axis the reception builder doesn't carry
 *
 *  A webhook door mints with `max_risk_without_approval: 'admin'` (D-209 §1.4 — the
 *  two-sided enrollment IS the standing approval: enabled on Recued AND pasted in the
 *  vendor console). The builder copies that authored ceiling onto the snapshot from the
 *  LIVE definition, and `resolveTrustCeiling` honors it only on the source's own
 *  `contract_id` match. Reception deliberately never carries the field — the reader pins
 *  a human-facing public door at `read` (rev-5 F3).
 *
 *  ## Fail-closed on a dead door — the kill-switch
 *
 *  Mirrors the reception rule verbatim: a source bound to a contract that is no longer
 *  live (revoked / expired / deleted) authorizes NOTHING — `allowed_tools` collapses to
 *  EMPTY (every dispatch denied, `tool_not_in_contract`) and the authored ceiling is
 *  DROPPED (an anonymous dispatch falls back to the pinned `read` ceiling). It composes
 *  with the §5.1 floor: a dead door's OPS fall to `PUBLIC_CONTRACT_ID` (which grants
 *  nothing) in `resolveGrantGoverningContractId`. Two axes, two fences, both closed —
 *  revoking the door contract is a live kill-switch over an already-enrolled vendor
 *  endpoint.
 *
 *  Spec: D-209 §1.4; D-207 §5.1 / §5.3 (the reception
 *  precedent this mirrors). */

import {
  contractPermitsDoorType,
  isContractActive,
  type ContractSnapshot,
  type ExecutionSource,
} from '@recued/contracts';

import { buildVersionedContractSnapshot } from './contract-snapshot-version.js';
import type { ContractDefinitionStore } from './storage/contract-definition-store.js';

export interface WebhookContractSnapshotDeps {
  readonly definitionStore: Pick<ContractDefinitionStore, 'get'>;
  readonly now: () => number;
}

/** WHICH ROUTE THE WEBHOOK PAYLOAD IS TAKING — and therefore whether D-209's
 *  authored ceiling is admissible on it at all.
 *
 *  ⛔⛔ REQUIRED, NOT DEFAULTED, DELIBERATELY. D-209's rule is *"an authored
 *  ceiling is admissible only where a MACHINE delivers a payload to a
 *  DETERMINISTIC PATH"*, and a defaulted parameter is how a future caller
 *  inherits the ceiling without ever answering that question. Making it a
 *  required closed union forces the answer at the call site — the same reason
 *  `GrantEntryKind` is a `Record`-keyed union that fails the build until a new
 *  member is placed.
 *
 *  - `'deterministic_handler'` — the vendor POSTs and the payload lands in a
 *    FIXED handler. This is the shape §1.4 reasoned about, and the two-sided
 *    enrollment genuinely is the standing approval for it.
 *  - `'recipe'` — the payload fires an ARBITRARY user recipe
 *    (`webhook-recipe-consumer.ts` runs `recipe_id: claim.recipe_id`). The
 *    premise does NOT hold: the recipe is user content that can contain any
 *    outbound send, and the enrollment approved THE VENDOR DELIVERING PAYLOADS,
 *    not whatever a recipe subsequently decides to do with them. Enrolling a
 *    Stripe webhook is not consent to message a peer.
 *
 *  ⚠ TODAY EVERY CALLER IS `'recipe'`, so the authored ceiling is DORMANT rather
 *  than deleted. That is the honest state and it is worth saying plainly: the
 *  mint still writes `max_risk_without_approval: 'admin'` on the door (it is a
 *  true property of the door under §1.4), and nothing reads it until a genuinely
 *  deterministic ingestion path exists to pass `'deterministic_handler'`. Driven
 *  in `d-209-webhook-outbound-send-ceiling.test.ts`. */
export type WebhookDispatchPath = 'deterministic_handler' | 'recipe';

/** Build the snapshot for a webhook dispatch, or fail closed.
 *
 *  Throws only on a source that is not a contract-bearing webhook dispatch — that is a
 *  wiring bug, not a runtime condition, and must not be swallowed. (A NULL-stamped
 *  trigger row is the runtime condition: the consumer builds a door-less source and the
 *  runner never calls this.) Every RUNTIME failure (dead door, unknown door, no tools)
 *  resolves to an EMPTY allowlist with NO ceiling, which denies. */
export const buildWebhookContractSnapshot = (
  source: ExecutionSource,
  deps: WebhookContractSnapshotDeps,
  dispatch_path: WebhookDispatchPath,
): ContractSnapshot => {
  if (source.channel !== 'webhook' || source.actor !== 'anonymous') {
    throw new Error(
      `D-209 buildWebhookContractSnapshot: expected (channel: 'webhook', actor: 'anonymous'); got (${source.channel}, ${source.actor}).`,
    );
  }
  const contractId = source.contract_id;
  if (typeof contractId !== 'string' || contractId.length === 0) {
    throw new Error(
      'D-209 buildWebhookContractSnapshot: the source carries no contract_id — a door-less dispatch (unstamped trigger row) must not build a snapshot; it floors at the gate instead.',
    );
  }

  // Door-CLASS binding (codex W3 MEDIUM): the stamped id must resolve to a contract
  // that BACKS a webhook door (`door_types` includes 'webhook'; empty/absent = the
  // wildcard convention). A trigger row somehow stamped with a reception door — or
  // any other contract — resolves DEAD here, so its ceiling can never be borrowed
  // across door classes. Same fail-closed shape as liveness: empty tools, no ceiling.
  const resolvedAt = deps.now();
  const def = deps.definitionStore.get(contractId);
  const live = def !== null
    && isContractActive(def, resolvedAt)
    && contractPermitsDoorType(def, 'webhook');

  // A dead / revoked / deleted door authorizes NOTHING. `allowed_tools: []` denies every
  // dispatch (`tool_not_in_contract`) — the live kill-switch over an enrolled endpoint.
  // The allowlist is the door's own stored scope — the SAME derivation the mint wrote its
  // grant rows from (`deriveRecipeCapability.ingredient_ids`), so the ACCESS and TOOL
  // axes can never disagree about what the door may do.
  const allowed_tools = live ? [...(def.scope?.ingredient_ids ?? [])] : [];

  return buildVersionedContractSnapshot({
    contract_id: contractId,
    allowed_tools,
    approval_required: [],
    scope_restrictions: [],
    resolved_at: resolvedAt,
    // The per-door authored ceiling (D-209 §1.4, minted `'admin'`) — copied from the
    // LIVE definition only, and ONLY onto a deterministic-handler dispatch. A dead
    // door must not keep relaxing writes, and neither must an arbitrary recipe:
    // dropping the field leaves the anonymous dispatch at the pinned LOW `read`
    // ceiling, which is where every other unattended trigger (schedule, reactive)
    // already sits.
    //
    // ⛔⛔ THIS IS THE FIX FOR A DRIVEN DEFECT, NOT A PRECAUTION. With the ceiling
    // on a recipe dispatch, an outbound send crossed admission with NO preflight:
    // `admin` relaxes the `write`, and `liftOutboundSend` is `user_self`-scoped so
    // nothing re-raises it. Same source, same send, ceiling removed ⇒ the gate
    // fires. See `d-209-webhook-outbound-send-ceiling.test.ts` for the A/B.
    ...(dispatch_path === 'deterministic_handler'
      && live && def.max_risk_without_approval !== undefined
      ? { max_risk_without_approval: def.max_risk_without_approval }
      : {}),
  });
};
