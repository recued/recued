/** D-202 — the `contract.quality_delegation_suggestion.*` store: the
 *  quality-delegation suggestion rows the (Slice 1) learner upserts and the
 *  `#contracts` "Quality auto-accept" panel reads. A near-direct mirror of the
 *  D-177 delegation-suggestion store — one row per canonical `(recipe, op)` key
 *  hash (`qualityDelegationSuggestionKeyHash`), keyed at
 *  `contract.quality_delegation_suggestion.<key_hash>`; the keyed `put` IS the
 *  UNIQUE-key upsert, every write validated against the
 *  `quality_delegation_suggestion` value_shape.
 *
 *  Same STATE MACHINE, enforced here (one race-free point against a concurrent
 *  accept/dismiss): absent → create `'open'`; `'open'` → refresh snapshot +
 *  evidence (idempotent — `updated_at` moves only on a material change);
 *  `'dismissed'` → never touched (per-key permanent; a fresh `recipe_hash`
 *  re-arms a new key); `'accepted'` → never re-opened by the learner.
 *
 *  Owner-surface only (the rpc family is reserved out of MCP). Local-only — the
 *  contract store never syncs cloud (D-090/D-097/D-168).
 *
 *  The suggestion SOURCE (the reject-driven learner) is Slice 1; until then a
 *  test/fake source calls `upsertOpen` directly.
 *
 *  Spec: D-202 §5 / §12.4. */

import { canonicalJSONStringify } from '@recued/crypto/canonical-json';
import {
  QUALITY_DELEGATION_SUGGESTION_SCOPE,
  type QualityDelegationSuggestionEvidence,
  type QualityDelegationSuggestionRow,
  type QualityDelegationSuggestionSnapshot,
} from '@recued/contracts';

import type { ContractStore } from './contract-store.js';

/** What an {@link QualityDelegationSuggestionStore.upsertOpen} did. `'created'`
 *  is the caller's bus-emit signal; `'updated'` / `'unchanged'` are silent
 *  recomputes; `'suppressed'` means the row's state forbids learner writes
 *  (dismissed / accepted — terminal for background learning). */
export type QualityDelegationSuggestionUpsertOutcome =
  | 'created'
  | 'updated'
  | 'unchanged'
  | 'suppressed';

export interface QualityDelegationSuggestionUpsertInput {
  readonly key_hash: string;
  readonly snapshot: QualityDelegationSuggestionSnapshot;
  readonly evidence: QualityDelegationSuggestionEvidence;
}

/** What a {@link QualityDelegationSuggestionStore.setState} did. `'changed'` —
 *  the open row transitioned; `'unchanged'` — already in that state
 *  (at-least-once rpc safety); `'refused'` — illegal transition / unknown stored
 *  state (fail closed); `'absent'` — no row. */
export type QualityDelegationSuggestionSetStateOutcome =
  | 'changed'
  | 'unchanged'
  | 'refused'
  | 'absent';

/** The suggestion read/write surface over
 *  `contract.quality_delegation_suggestion.*`. */
export interface QualityDelegationSuggestionStore {
  /** Read one suggestion by key hash; `null` when absent. */
  get(key_hash: string): QualityDelegationSuggestionRow | null;
  /** Every suggestion row, most-recently-updated first (`key_hash` ascending as
   *  a stable tiebreak) — the panel feed. Includes every state; the panel
   *  filters/sections. */
  list(): QualityDelegationSuggestionRow[];
  /** The learner's idempotent UNIQUE-key upsert (the module doc's state
   *  machine). Returns what happened so the caller fans the bus event on
   *  `'created'` and stays silent otherwise. */
  upsertOpen(
    input: QualityDelegationSuggestionUpsertInput,
  ): QualityDelegationSuggestionUpsertOutcome;
  /** The OWNER's resolution write (accept/dismiss rpc; separate from
   *  `upsertOpen`, which stays learner-only): transition an `'open'` row to
   *  `'accepted'` or `'dismissed'`. Only open→accepted / open→dismissed are
   *  legal; a same-state retry is `'unchanged'` (at-least-once safety); every
   *  other shape is `'refused'` (fail closed). Snapshot + evidence are never
   *  touched here — the accept mints from exactly the stored snapshot. */
  setState(
    key_hash: string,
    next: 'accepted' | 'dismissed',
  ): {
    outcome: QualityDelegationSuggestionSetStateOutcome;
    row: QualityDelegationSuggestionRow | null;
  };
}

export interface CreateQualityDelegationSuggestionStoreOptions {
  /** Time source for `created_at` / `updated_at` (epoch-ms). Defaults to
   *  `Date.now`. Tests inject a deterministic clock. */
  now?: () => number;
}

/** Wrap a {@link ContractStore} as the {@link QualityDelegationSuggestionStore}.
 *  Stateless beyond the injected clock (mirrors the delegation suggestion
 *  store). */
export const createQualityDelegationSuggestionStore = (
  store: ContractStore,
  opts?: CreateQualityDelegationSuggestionStoreOptions,
): QualityDelegationSuggestionStore => {
  const now = opts?.now ?? ((): number => Date.now());

  const read = (key_hash: string): QualityDelegationSuggestionRow | null => {
    const row = store.get(QUALITY_DELEGATION_SUGGESTION_SCOPE, [key_hash]);
    return row ? (row.value as QualityDelegationSuggestionRow) : null;
  };

  return {
    get(key_hash) {
      return read(key_hash);
    },

    list() {
      return store
        .scan(QUALITY_DELEGATION_SUGGESTION_SCOPE)
        .map((row) => row.value as QualityDelegationSuggestionRow)
        .sort((a, b) => {
          if (a.updated_at !== b.updated_at) return b.updated_at - a.updated_at;
          if (a.key_hash < b.key_hash) return -1;
          if (a.key_hash > b.key_hash) return 1;
          return 0;
        });
    },

    upsertOpen(input) {
      const existing = read(input.key_hash);
      if (existing === null) {
        const at = now();
        const row: QualityDelegationSuggestionRow = {
          key_hash: input.key_hash,
          state: 'open',
          snapshot: input.snapshot,
          evidence: input.evidence,
          created_at: at,
          updated_at: at,
        };
        store.put(QUALITY_DELEGATION_SUGGESTION_SCOPE, [input.key_hash], row);
        return 'created';
      }
      // Terminal-for-the-learner states — never overridden by background
      // learning (fail closed on unknown future state too).
      if (existing.state !== 'open') return 'suppressed';
      if (
        canonicalJSONStringify(existing.snapshot) === canonicalJSONStringify(input.snapshot)
        && canonicalJSONStringify(existing.evidence) === canonicalJSONStringify(input.evidence)
      ) {
        return 'unchanged';
      }
      const updated: QualityDelegationSuggestionRow = {
        ...existing,
        snapshot: input.snapshot,
        evidence: input.evidence,
        updated_at: now(),
      };
      store.put(QUALITY_DELEGATION_SUGGESTION_SCOPE, [input.key_hash], updated);
      return 'updated';
    },

    setState(key_hash, next) {
      const existing = read(key_hash);
      if (existing === null) return { outcome: 'absent', row: null };
      if (existing.state === next) return { outcome: 'unchanged', row: existing };
      // Only an OPEN row resolves; a cross-resolution flip or unknown stored
      // state is refused (dismissal is per-key permanent; an accepted key's
      // grant is governed via revoke, not by re-flipping the suggestion).
      if (existing.state !== 'open') return { outcome: 'refused', row: existing };
      const updated: QualityDelegationSuggestionRow = {
        ...existing,
        state: next,
        updated_at: now(),
      };
      store.put(QUALITY_DELEGATION_SUGGESTION_SCOPE, [key_hash], updated);
      return { outcome: 'changed', row: updated };
    },
  };
};
