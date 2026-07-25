/** D-182 §7.2 — the `contract.cli_reachability`-backed store for the per-contract
 *  cli-op reachability grid (the `cli.reachability.*` grid rpc writes it — the
 *  "Local tools" Settings panel + the install grant dialog; the catalog gateway's
 *  `cli` authorization stage ENFORCES it).
 *
 *  A `cli` op is connection-LESS and §8-forbidden as a raw door tool, and the ONLY
 *  entry point to any cli is a pack — so cli access is a per-(contract × pack-op)
 *  grant, the SAME shape every other pack-op uses, just with no connection binding
 *  hanging off it. The grant is keyed on the OPERATION (`(principal, ingredient_id,
 *  operation_id)`: the cli ingredient carries the pack/catalog binding, the op id
 *  names the callable op) — NOT on risk tier. Risk tier is orthogonal: it decides
 *  whether the action NOTIFIES the owner (write/destructive → ask), never admission,
 *  so it lives outside the grant key (the gateway's approval stage, not here).
 *
 *  A present row with `allowed: true` admits; an ABSENT row DENIES (fail-closed,
 *  capabilities default OFF). The owner's own bit lives under
 *  `CLI_REACHABILITY_OWNER_PRINCIPAL`, one row among the door/agent contracts.
 *  Local-only by construction — the contract store never syncs cloud
 *  (D-090/D-097/D-168).
 *
 *  The gateway's cli authorization stage ENFORCES this allowlist via
 *  `createCliReachabilityResolver` + the execution-source → principal mapping
 *  (`cliPrincipalFromExecutionSource`); the `cli.reachability.*` grid rpc writes
 *  it. It is the connection-less cli analogue of a connection profile.
 *
 *  Spec: D-182 §7.2; decisions-log D-182 amendment (F1 RESOLVED). */

import type { CliReachabilityState } from '@recued/contracts';
import type { ContractStore } from './contract-store.js';

/** The `cli_reachability` scope name (a `composite_keys` entry in the contract
 *  schema, keyed by `(principal, ingredient_id, operation_id)`). */
const CLI_REACHABILITY_SCOPE = 'cli_reachability';

/** Segment depth — `[principal, ingredient_id, operation_id]`. */
const CLI_REACHABILITY_SEGMENT_COUNT = 3;
const PRINCIPAL_SEGMENT = 0;
const INGREDIENT_SEGMENT = 1;
const OPERATION_SEGMENT = 2;

/** One persisted reachability row (the `cli_reachability_state` value plus its
 *  key). `principal` is the owner (`user_self`) or a door/agent `contract_id`;
 *  `ingredient_id` is the cli catalog ingredient (carries the pack/catalog
 *  binding); `operation_id` is the granted callable op (the pack-op). */
export interface CliReachabilityRow {
  principal: string;
  ingredient_id: string;
  operation_id: string;
  allowed: boolean;
  set_at?: number;
}

export interface CliReachabilityStore {
  /** True iff `(principal, ingredient_id, operation_id)` has a present row with
   *  `allowed: true` (absent ⇒ false ⇒ the gateway denies, fail closed). */
  isAllowed(principal: string, ingredient_id: string, operation_id: string): boolean;
  /** The full row, or null when absent (off). */
  get(principal: string, ingredient_id: string, operation_id: string): CliReachabilityRow | null;
  /** Owner opt-IN — record/replace the reachability row (idempotent under the
   *  `override` merge_rule). `now` (epoch ms) stamps it for the grid + audit. */
  allow(principal: string, ingredient_id: string, operation_id: string, now: number): void;
  /** Owner opt-OUT — drop the row (absent ⇒ denied, the canonical off state). */
  deny(principal: string, ingredient_id: string, operation_id: string): void;
  /** Every reachability row — the Local-tools grid reads this. Snapshot
   *  semantics; order by the store's seg_key. */
  list(): CliReachabilityRow[];
  /** Every reachability row for one principal (the grid's per-contract row). */
  listForPrincipal(principal: string): CliReachabilityRow[];
}

/** Defensive read of a `cli_reachability_state` value — `allowed` must be a real
 *  boolean, else the row is ignored (a malformed row is never trusted as ON). */
const readState = (
  value: unknown,
): { allowed: boolean; set_at?: number } | undefined => {
  if (value === null || typeof value !== 'object') return undefined;
  const v = value as Partial<CliReachabilityState>;
  if (typeof v.allowed !== 'boolean') return undefined;
  return {
    allowed: v.allowed,
    ...(typeof v.set_at === 'number' ? { set_at: v.set_at } : {}),
  };
};

/** Wrap a {@link ContractStore} as the {@link CliReachabilityStore}. Stateless —
 *  every call forwards to the shared store handle; safe to construct more than
 *  once over the same store. */
export const createCliReachabilityStore = (
  contractStore: ContractStore,
): CliReachabilityStore => {
  const read = (
    principal: string,
    ingredient_id: string,
    operation_id: string,
  ): CliReachabilityRow | null => {
    const state = readState(
      contractStore.get(CLI_REACHABILITY_SCOPE, [principal, ingredient_id, operation_id])?.value,
    );
    return state ? { principal, ingredient_id, operation_id, ...state } : null;
  };
  const rowsUnder = (prefix: readonly string[]): CliReachabilityRow[] => {
    const out: CliReachabilityRow[] = [];
    for (const row of contractStore.scan(CLI_REACHABILITY_SCOPE, prefix)) {
      if (row.segments.length !== CLI_REACHABILITY_SEGMENT_COUNT) continue;
      const state = readState(row.value);
      if (state) {
        out.push({
          principal: row.segments[PRINCIPAL_SEGMENT],
          ingredient_id: row.segments[INGREDIENT_SEGMENT],
          operation_id: row.segments[OPERATION_SEGMENT],
          ...state,
        });
      }
    }
    return out;
  };
  return {
    isAllowed(principal, ingredient_id, operation_id) {
      return read(principal, ingredient_id, operation_id)?.allowed === true;
    },

    get(principal, ingredient_id, operation_id) {
      return read(principal, ingredient_id, operation_id);
    },

    allow(principal, ingredient_id, operation_id, now) {
      contractStore.put(CLI_REACHABILITY_SCOPE, [principal, ingredient_id, operation_id], {
        allowed: true,
        set_at: now,
      } satisfies CliReachabilityState);
    },

    deny(principal, ingredient_id, operation_id) {
      contractStore.delete(CLI_REACHABILITY_SCOPE, [principal, ingredient_id, operation_id]);
    },

    list() {
      return rowsUnder([]);
    },

    listForPrincipal(principal) {
      return rowsUnder([principal]);
    },
  };
};

/** D-182 §7.2 — the engine's per-contract cli reachability check (the gateway's
 *  `cli` authorization stage ENFORCES it). A recipe run under `principal` may
 *  reach `(ingredient_id, operation_id)` IFF a present row says `allowed: true`.
 *  A `null` principal (an execution source with no definite principal — see
 *  `cliPrincipalFromExecutionSource`) DENIES, fail closed. The ingredient key
 *  carries the catalog binding, so a different pack reusing the same op name on a
 *  different ingredient is not silently authorized. */
export const createCliReachabilityResolver = (
  store: Pick<CliReachabilityStore, 'isAllowed'>,
): ((principal: string | null, ingredient_id: string, operation_id: string) => boolean) =>
  (principal, ingredient_id, operation_id) =>
    principal !== null && store.isAllowed(principal, ingredient_id, operation_id);
