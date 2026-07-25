/** D-182 §7.2 — per-contract cli-tool reachability: the substrate the "Local
 *  tools" grid + the install grant dialog write, and the catalog gateway's `cli`
 *  authorization stage ENFORCES (increment 3).
 *
 *  A `cli` op (whisper / ffmpeg / magick / docling) is connection-LESS, and §8
 *  forbids exposing it as a RAW door tool. But a recipe TRIGGERED by a contract
 *  may internally run the binary — and the owner controls that per-contract:
 *  "this contract may trigger recipes, but none of its recipes may shell out to a
 *  local binary." That control is one INDEPENDENT per-(principal × cli-ingredient
 *  × risk_tier) grant, NOT a baseline+overlay — every contract-aware merge scope
 *  (`override` / `policy_matrix`) is tightening-only and cannot carry a
 *  per-contract LOOSEN, so reachability is a plain allowlist: a present row with
 *  `allowed: true` admits, an ABSENT row DENIES (fail-closed). No baseline ⇒ no
 *  overlay ⇒ no tightening-only conflict (resolves D-182 Codex F1).
 *
 *  This module is the shared (engine + backend) vocabulary: the row shape, the
 *  owner principal, and the execution-source → principal mapping. The store +
 *  resolver live server-side (`backend/server/src/storage/cli-reachability-store.ts`).
 *
 *  Spec: D-182 §7.2; decisions-log D-182 amendment (F1 RESOLVED). */

/** The owner's principal key (the "Owner (you)" row of the §7.2 grid). The owner
 *  is D-177 `user_self`; their cli reachability bit lives under this principal,
 *  one row among the door/agent contracts. NB: this equals the `user_self` actor
 *  string by construction — the owner is the only `user_self` principal. */
export const CLI_REACHABILITY_OWNER_PRINCIPAL = 'user_self' as const;

/** One persisted per-(principal, cli-ingredient, risk_tier) reachability grant —
 *  the `cli_reachability_state` value_shape. `allowed: true` (a present row) ⇒
 *  reachable; absent ⇒ denied. `set_at` is epoch-ms (the contract store's
 *  `datetime` convention) — when the owner set the bit, for the grid + audit. */
export interface CliReachabilityState {
  allowed: boolean;
  set_at?: number;
}

/** The execution-source facets the principal mapping reads. Increment 2 supplies
 *  these from the gateway's resolved ExecutionSource (channel × actor ×
 *  contract_id); only the two fields the mapping needs are named here. */
export interface CliReachabilityExecutionSource {
  /** The D-153/D-177 actor (`user_self` / `contracted_user` / `anonymous` /
   *  `system`). */
  actor: string;
  /** The contract the call runs under, when there is one (a door/agent). Absent
   *  for the owner's own (`user_self`) path. */
  contract_id?: string;
}

/** Map an execution source to its reachability PRINCIPAL (the §7.2 grid row key).
 *  Order matters (Codex F-V2): a **contract in force wins first** — any execution
 *  carrying a `contract_id` resolves to THAT contract's row, even when the actor
 *  is the owner. `execution_source.contract_id` is independent of the actor
 *  (`executionSourceContractId` — `commits.ts`), so a **self-restricted owner**
 *  (`actor: 'user_self'` running under a contract they minted to limit themselves)
 *  carries both; resolving owner-first would BYPASS that self-restriction and
 *  authorize against the full owner row. So:
 *
 *    1. a `contract_id` present → that contract's principal (honor the contract);
 *    2. else the actor is the UNRESTRICTED owner (`user_self`, no contract) →
 *       the owner principal;
 *    3. else (any other actor with no contract — `contracted_user` / `anonymous`
 *       / `system` lacking a contract) → `null`, and the resolver DENIES
 *       (fail-closed; the unwired increment never widens reachability).
 *
 *  A `contracted_user` can never reach branch 2 — the engine sets `actor` from the
 *  execution source, an agent can't forge `user_self`, and a contracted run always
 *  carries its `contract_id` (branch 1). */
export const cliPrincipalFromExecutionSource = (
  src: CliReachabilityExecutionSource,
): string | null => {
  if (typeof src.contract_id === 'string' && src.contract_id.length > 0) return src.contract_id;
  if (src.actor === CLI_REACHABILITY_OWNER_PRINCIPAL) return CLI_REACHABILITY_OWNER_PRINCIPAL;
  return null;
};
