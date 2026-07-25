/** Grant-foundation slice 3b (D-187 AMENDMENT `693b7d03`) — the GOVERNING-CONTRACT
 *  resolver: the ONE place that answers "whose grant rows gate this dispatch?".
 *
 *  The owner-dialogue model (2026-06-22) splits the (channel × actor) surfaces three
 *  ways:
 *    - **`(chat | messenger, user_self)`** — the AI acting in the OWNER's own chat /
 *      remote-command surface. Gated by the ONE owner contract (`OWNER_CONTRACT_ID`),
 *      seeded permissive + tightenable. The ExecutionSource stays STRUCTURALLY
 *      contract-free (no `contract_id` field) — carrying one would trip the
 *      "contract-bearing source requires a ContractSnapshot" guard (`policy-gate.ts`)
 *      and re-arm the FAIL_CLOSED-snapshot machinery the owner has no snapshot for.
 *      So the owner contract is resolved HERE, at the gate, from `(channel, actor)` —
 *      contract-free in structure, owner-gated in semantics.
 *    - **`(mcp | chat | …, contracted_user)`** — a door. Gated by the door's own
 *      bound `contract_id` (the same id the overlay + snapshot key on). ANY contract.
 *    - **`(user, user_self)` + the system channels** (`schedule` / `reactive` /
 *      `housekeeping`) — CONTRACT-FREE: the human's direct HID + the server's
 *      internal tasks are outside the grant axis (owner-directed). No grant gate
 *      applies; the baseline `(channel, actor)` cell is the sole authority.
 *      (`webhook` left this set in D-209 #1 W3: it is now an `anonymous` DOOR
 *      source — its stamped door contract governs, and an unstamped dispatch
 *      floors to `PUBLIC_CONTRACT_ID` via the anonymous branch below.)
 *
 *  This module is the single source of that mapping, consumed by BOTH admission gates:
 *  the op-admission gate (the `op` grant entry) AND the read gate (the `enrichment.
 *  <topic>` / `data.<collection>` entries + the verb-op term). Keeping it in one place
 *  means op-admission and reads can never disagree about who governs a dispatch.
 *
 *  Liveness is folded in by {@link resolveGrantGoverningContractId}: the owner is
 *  ALWAYS live (a sentinel storage key, not a minted `contract_definition` — it has no
 *  lifecycle to expire); a bound door is gated on `active ∧ grant-governing-kind`:
 *  ordinary standing contracts and D-196 `customer_instance` rows govern, while
 *  templates / gate grants / unknown future kinds do not. A door with no
 *  `contract_definition` row (the synthetic per-MCP-token id — stdio owner /
 *  canonical CLI bearer) resolves to `undefined`: no grant gate, the snapshot's
 *  `allowed_tools` stays the sole authority for that path (unchanged).
 *
 *  Spec: D-187 AMENDMENT block; handover
 *  `handover_grant_slice3_session1_3b_admission_actor.md` (steps 5 / 8). */

import {
  executionSourceContractId,
  isContractActive,
  isReservedOwnerContractId,
  isStandingContractDefinition,
  OWNER_CONTRACT_ID,
  PUBLIC_CONTRACT_ID,
  type ExecutionSource,
} from '@recued/contracts';

import type { ContractDefinitionStore } from './storage/contract-definition-store.js';

/** The channels on which an `actor: 'user_self'` dispatch is the OWNER's own AI (and
 *  therefore gated by the owner contract). `chat` = the webclient assistant; `messenger`
 *  = the owner's Slack / Telegram / email remote-command surface. NOT `user` — that is
 *  the human's direct HID, which stays contract-free (outside the grant axis). */
const OWNER_AI_CHANNELS: ReadonlySet<string> = new Set(['chat', 'messenger']);

/** Door / standing-contract liveness gate — the `(active ∧ standing-kind)` test the
 *  overlay applies, with NO owner special-case. A non-empty `id` (a contracted source's
 *  bound `contract_id`, or a recipe-channel `origin_contract_id`) is treated as a bound
 *  door / standing contract: it governs ONLY while its `contract_definition` is
 *  `isContractActive(now)` and an ordinary standing row; else
 *  (a dead / revoked / expired / grant-kind / absent def — incl. the synthetic per-MCP-
 *  token id with no def) → `undefined`: no grant gate (the snapshot governs; reads fall
 *  to author-default).
 *
 *  ⚠ The OWNER sentinel is NEVER always-live HERE — this is the privilege-escalation
 *  fence (codex 3b HIGH). A contracted source's bound `contract_id`, or a recipe
 *  `origin_contract_id`, can never legitimately BE the owner: the owner contract is
 *  DERIVED from an owner-AI source by {@link resolveGrantGoverningContractId}, never
 *  bound to a door or carried by a recipe. So an explicit id that happens to equal
 *  `OWNER_CONTRACT_ID` finds no `contract_definition` (the owner is a sentinel, not a
 *  minted def) → resolves dead → `undefined` — a door bound to `'user_self'` can never
 *  inherit the owner's permissive grant rows. (Binding / minting `OWNER_CONTRACT_ID` as a
 *  door id is ALSO rejected at the contract boundary — defense in depth, see
 *  `isReservedOwnerContractId`.) Stateless beyond the injected store + clock. */
export const gateStandingContractId = (
  id: string | undefined,
  definitionStore: ContractDefinitionStore,
  now: () => number,
): string | undefined => {
  if (id === undefined || id.length === 0) return undefined;
  // Fail CLOSED for the reserved OWNER sentinel BEFORE the definition lookup (codex 3b
  // HIGH, defense in depth): an explicit / bound id equal to `OWNER_CONTRACT_ID` can
  // NEVER resolve to a governing contract here, regardless of stored state — so a stale
  // import / direct store write / missed boundary that left a live `contract_definition`
  // row at `'user_self'` still can't let a door inherit the owner's grant rows. The owner
  // is reached ONLY by the derived owner-AI branch in `resolveGrantGoverningContractId`
  // (which returns the sentinel WITHOUT calling this), never through a bound id.
  if (isReservedOwnerContractId(id)) return undefined;
  const def = definitionStore.get(id);
  if (
    def &&
    isContractActive(def, now()) &&
    isStandingContractDefinition(def)
  ) {
    return id;
  }
  return undefined;
};

/** Bound-door grant-governance gate. D-196 customer instances are real live
 *  doors whose self-contained `contract_grant` rows govern reads and ops; their
 *  templates are authoring sources only and remain inert. Keeping the ordinary
 *  standing helper separate preserves strict standing-only consumers. */
export const gateGrantGoverningContractId = (
  id: string | undefined,
  definitionStore: ContractDefinitionStore,
  now: () => number,
): string | undefined => {
  if (id === undefined || id.length === 0 || isReservedOwnerContractId(id)) {
    return undefined;
  }
  const def = definitionStore.get(id);
  if (
    def
    && isContractActive(def, now())
    && (isStandingContractDefinition(def) || def.grant_kind === 'customer_instance')
  ) {
    return id;
  }
  return undefined;
};

/** The contract id whose grant rows GOVERN `source`, LIVENESS-GATED — the value the
 *  op-admission gate + the source-bearing read-grant producer key on:
 *    - a source carrying an EXPLICIT `contract_id` (a `contracted_user` door, or a
 *      self-restricted `user_self`) → liveness-gated as an ordinary standing or
 *      D-196 customer-instance contract ({@link gateGrantGoverningContractId}).
 *      NEVER owner-always-live, even if the id equals
 *      `OWNER_CONTRACT_ID` — a bound contract can't be the owner sentinel (the escalation
 *      fence); a dead / absent def ⇒ `undefined` (no grant gate; the snapshot governs).
 *    - else an OWNER-AI surface (`(chat | messenger, user_self)` with NO explicit
 *      `contract_id`) → the OWNER contract ({@link OWNER_CONTRACT_ID}, the always-live
 *      sentinel — no `contract_definition` lifecycle to expire; its seeded rows always
 *      apply). This DERIVATION is the ONLY path that yields the owner-always-live
 *      treatment — keyed on PROVENANCE (a contract-free owner-AI source), not on the bare
 *      string value.
 *    - else (`(user, user_self)` HID, the system channels) → `undefined` (contract-free).
 *
 *  Stateless beyond the injected store + clock. */
export const resolveGrantGoverningContractId = (
  source: ExecutionSource,
  definitionStore: ContractDefinitionStore,
  now: () => number,
): string | undefined => {
  const explicit = executionSourceContractId(source);
  // An explicit contract_id is ALWAYS a bound door — never the owner
  // sentinel, even if it literally equals OWNER_CONTRACT_ID (the escalation fence: the
  // owner is derived, never bound). Liveness-gate it via its contract_definition.
  if (explicit !== undefined) {
    const gated = gateGrantGoverningContractId(explicit, definitionStore, now);
    if (gated !== undefined) return gated;
    // D-207 slice 1b — a DEAD / revoked / deleted door contract must not drop an
    // ANONYMOUS dispatch back to contract-free. `gateGrantGoverningContractId` returns
    // `undefined` for a dead def, and `undefined` means "no grant gate" downstream — so
    // for every OTHER channel a dead door correctly falls back to its snapshot's
    // `allowed_tools`, but a public visitor has no such second fence. Deleting the door
    // contract would therefore OPEN the door instead of closing it. Fall to the floor.
    if (source.actor === 'anonymous') return PUBLIC_CONTRACT_ID;
    return undefined;
  }
  // No explicit contract_id: an owner-AI surface IS the owner contract (always live).
  if (source.actor === 'user_self' && OWNER_AI_CHANNELS.has(source.channel)) {
    return OWNER_CONTRACT_ID;
  }
  // D-207 slice 1b — an ANONYMOUS public dispatch can never be contract-free.
  //
  // `isOpGranted` reads `undefined` as "contract-free → no grant gate" and returns
  // TRUE — it SKIPS the ACCESS gate entirely. That is correct for the owner's own HID
  // and the system channels; it is catastrophic for a public visitor. Before this, an
  // owner who deleted a paired recipe's contract while leaving the pair enabled would
  // not TIGHTEN the door, they would BLOW IT OPEN — the revoke that doesn't revoke.
  //
  // A missing / dead / deleted door contract therefore falls back to the seeded,
  // undeletable PUBLIC sentinel, which grants NOTHING (deny-by-default via
  // `usesExplicitOnlyGrantDefaults`). The floor is unconditional: it does not depend on
  // the door contract existing, being live, or having been derived correctly.
  if (source.actor === 'anonymous') {
    return PUBLIC_CONTRACT_ID;
  }
  return undefined;
};
