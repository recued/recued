/** D-177 N.13 (P6b) — the `contract.delegation_rule_suggestion.*` store: the
 *  staged-trust suggestion rows the housekeeping learner upserts and the P6c
 *  `#contracts` "Suggested rules" panel reads.
 *
 *  One row per canonical N.13 key hash (`delegationRuleSuggestionKeyHash`),
 *  keyed at `contract.delegation_rule_suggestion.<key_hash>` — the contract
 *  store's keyed `put` IS the spec's UNIQUE-key upsert, and every write is
 *  validated against the `delegation_rule_suggestion` value_shape (incl. the
 *  nested snapshot + evidence shapes, `contract-schema.ts`).
 *
 *  The STATE MACHINE is enforced here, not in the learner (one enforcement
 *  point, race-free against a concurrent P6c accept/dismiss):
 *
 *  - absent row            → create `'open'` (`created_at` stamps the first
 *                            firing) — the caller fans the bus event,
 *  - `'open'` row          → refresh snapshot + evidence; `updated_at` moves
 *                            ONLY when the recompute actually changed the row
 *                            (idempotent re-runs are no-op writes),
 *  - `'dismissed'` row     → NEVER touched — dismissal is per-key permanent
 *                            (N.13; `recipe_hash` in the key re-arms
 *                            naturally on recipe update via a FRESH key),
 *  - `'accepted'` row      → never re-opened by the learner (the P6c mint
 *                            happened; re-surfacing after the minted rule's
 *                            natural expiry is the P6c surface's call, not
 *                            background learning's).
 *
 *  Suggestions are NEVER serialized into model-visible context, tool results,
 *  or the chat catalog (N.9.1): this store backs the owner-surface rpc (P6c,
 *  reserved out of MCP) and the learner only. Local-only — the contract store
 *  never syncs cloud (D-090/D-097/D-168).
 *
 *  Spec: D-177 § N.13; landing order P6b. */

import { canonicalJSONStringify } from '@recued/crypto/canonical-json';
import {
  DELEGATION_RULE_SUGGESTION_SCOPE,
  type DelegationRuleSuggestionEvidence,
  type DelegationRuleSuggestionRow,
  type DelegationRuleSuggestionSnapshot,
} from '@recued/contracts';

import type { ContractStore } from './contract-store.js';

/** What an {@link DelegationSuggestionStore.upsertOpen} call did. `'created'`
 *  is the caller's bus-emit signal (a NEW suggestion fired); `'updated'` /
 *  `'unchanged'` are silent recomputes; `'suppressed'` means the row's state
 *  forbids learner writes (dismissed / accepted — both terminal for
 *  background learning). */
export type DelegationSuggestionUpsertOutcome =
  | 'created'
  | 'updated'
  | 'unchanged'
  | 'suppressed';

export interface DelegationSuggestionUpsertInput {
  readonly key_hash: string;
  readonly snapshot: DelegationRuleSuggestionSnapshot;
  readonly evidence: DelegationRuleSuggestionEvidence;
}

/** What a {@link DelegationSuggestionStore.setState} call did. `'changed'` —
 *  the open row transitioned (the caller broadcasts + proceeds);
 *  `'unchanged'` — the row already carried the requested state (idempotent
 *  retry — at-least-once safe); `'refused'` — the transition is illegal
 *  (cross-resolution flip like dismissed→accepted, or an unknown stored
 *  state — fail closed); `'absent'` — no row at that key hash. */
export type DelegationSuggestionSetStateOutcome =
  | 'changed'
  | 'unchanged'
  | 'refused'
  | 'absent';

/** The suggestion read/write surface over `contract.delegation_rule_suggestion.*`. */
export interface DelegationSuggestionStore {
  /** Read one suggestion by key hash; `null` when absent. */
  get(key_hash: string): DelegationRuleSuggestionRow | null;
  /** Every suggestion row, most-recently-updated first (`key_hash` ascending
   *  as a stable tiebreak) — the P6c panel feed. Includes every state; the
   *  panel filters/sections, the learner never reads the listing. */
  list(): DelegationRuleSuggestionRow[];
  /** The learner's idempotent UNIQUE-key upsert (see the module doc's state
   *  machine). Returns what happened so the caller can fan the bus event on
   *  `'created'` and stay silent otherwise. */
  upsertOpen(input: DelegationSuggestionUpsertInput): DelegationSuggestionUpsertOutcome;
  /** D-177 N.13 (P6c) — the OWNER's resolution write (accept/dismiss rpc;
   *  deliberately separate from `upsertOpen`, which stays learner-only):
   *  transition an `'open'` row to `'accepted'` or `'dismissed'`. The only
   *  legal transitions are open→accepted and open→dismissed — a same-state
   *  retry is `'unchanged'` (at-least-once rpc safety), every other shape
   *  (cross-resolution flip, unknown stored state on a hand-shaped JSON row)
   *  is `'refused'`, fail closed. `'changed'` moves `updated_at`; snapshot +
   *  evidence are never touched here (the row keeps what the card showed —
   *  the accept mints from exactly that snapshot). */
  setState(
    key_hash: string,
    next: 'accepted' | 'dismissed',
  ): { outcome: DelegationSuggestionSetStateOutcome; row: DelegationRuleSuggestionRow | null };
}

export interface CreateDelegationSuggestionStoreOptions {
  /** Time source for `created_at` / `updated_at` (epoch-ms). Defaults to
   *  `Date.now`. Tests inject a deterministic clock. */
  now?: () => number;
}

/** Wrap a {@link ContractStore} as the {@link DelegationSuggestionStore}.
 *  Stateless beyond the injected clock — safe to construct more than once
 *  over the same store (mirrors `createContractDefinitionStore`). */
export const createDelegationSuggestionStore = (
  store: ContractStore,
  opts?: CreateDelegationSuggestionStoreOptions,
): DelegationSuggestionStore => {
  const now = opts?.now ?? ((): number => Date.now());

  // Every DATA row at this scope is a validated `delegation_rule_suggestion`
  // value (writes go through `store.put`), so the narrowing from `unknown` is
  // sound — mirrors `createContractDefinitionStore`'s read.
  const read = (key_hash: string): DelegationRuleSuggestionRow | null => {
    const row = store.get(DELEGATION_RULE_SUGGESTION_SCOPE, [key_hash]);
    return row ? (row.value as DelegationRuleSuggestionRow) : null;
  };

  return {
    get(key_hash) {
      return read(key_hash);
    },

    list() {
      return store
        .scan(DELEGATION_RULE_SUGGESTION_SCOPE)
        .map((row) => row.value as DelegationRuleSuggestionRow)
        .sort((a, b) => {
          if (a.updated_at !== b.updated_at) return b.updated_at - a.updated_at;
          // Deterministic tiebreak (hex key hashes are ascii — plain
          // comparison agrees with SQLite's BINARY order).
          if (a.key_hash < b.key_hash) return -1;
          if (a.key_hash > b.key_hash) return 1;
          return 0;
        });
    },

    upsertOpen(input) {
      const existing = read(input.key_hash);
      if (existing === null) {
        const at = now();
        const row: DelegationRuleSuggestionRow = {
          key_hash: input.key_hash,
          state: 'open',
          snapshot: input.snapshot,
          evidence: input.evidence,
          created_at: at,
          updated_at: at,
        };
        // `put` validates the value_shape (incl. the nested snapshot +
        // evidence) and is a keyed upsert — a fresh key hash is an insert.
        store.put(DELEGATION_RULE_SUGGESTION_SCOPE, [input.key_hash], row);
        return 'created';
      }
      // Terminal-for-the-learner states — dismissed is per-key permanent,
      // accepted marks the P6c mint. Background learning never overrides a
      // human's resolution (N.9.7's spirit at the row level). Unknown future
      // state vocabulary on a JSON row suppresses the same way (fail closed).
      if (existing.state !== 'open') return 'suppressed';
      // Idempotent recompute — only a MATERIAL change writes (and moves
      // `updated_at`). Canonical serialization compares key-order-insensitively
      // (rows are JSON round-tripped; insertion order is not identity).
      if (
        canonicalJSONStringify(existing.snapshot) === canonicalJSONStringify(input.snapshot)
        && canonicalJSONStringify(existing.evidence) === canonicalJSONStringify(input.evidence)
      ) {
        return 'unchanged';
      }
      const updated: DelegationRuleSuggestionRow = {
        ...existing,
        snapshot: input.snapshot,
        evidence: input.evidence,
        updated_at: now(),
      };
      store.put(DELEGATION_RULE_SUGGESTION_SCOPE, [input.key_hash], updated);
      return 'updated';
    },

    setState(key_hash, next) {
      const existing = read(key_hash);
      if (existing === null) return { outcome: 'absent', row: null };
      // At-least-once rpc safety: a retry of the same resolution is a no-op
      // success (the accept rpc separately dedupes its mint on the rule's
      // `approved_action_ref` anchor).
      if (existing.state === next) return { outcome: 'unchanged', row: existing };
      // Only an OPEN row resolves. A cross-resolution flip (dismissed→
      // accepted or accepted→dismissed) is refused — dismissal is per-key
      // permanent, and an accepted key's rule is governed via the rule row
      // (revoke), not by re-flipping the suggestion. Unknown stored states on
      // a hand-shaped JSON row refuse the same way (fail closed).
      if (existing.state !== 'open') return { outcome: 'refused', row: existing };
      const updated: DelegationRuleSuggestionRow = {
        ...existing,
        state: next,
        updated_at: now(),
      };
      store.put(DELEGATION_RULE_SUGGESTION_SCOPE, [key_hash], updated);
      return { outcome: 'changed', row: updated };
    },
  };
};
