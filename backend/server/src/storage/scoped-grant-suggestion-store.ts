/** D-177 N.11 rule 5 (5.c, slice C) — the `contract.scoped_grant_suggestion.*`
 *  store: the utterance-derived scoped-grant proposal rows the D-160 parse
 *  middleware files and the accept/dismiss rpc resolves.
 *
 *  Deliberately a SEPARATE store from `delegation-suggestion-store.ts`
 *  (codex MEDIUM fold, 5.c): same suggest→accept SHAPE, different row kind +
 *  key namespace — scoped proposals must never enter the delegation
 *  learner's scan or key derivation (5.i.2). One row per canonical
 *  `scopedGrantSuggestionKeyHash` (session × catalog op × source); the
 *  contract store's keyed `put` IS the unique-key upsert, so a re-utterance
 *  refreshes the open card instead of stacking duplicates.
 *
 *  State machine mirrors the delegation store's (one enforcement point,
 *  race-free against a concurrent accept/dismiss):
 *  - absent          → create `'open'` (caller fans the bus event),
 *  - `'open'`        → refresh snapshot/excerpt/candidates; `updated_at`
 *                      moves only on material change,
 *  - `'dismissed'`   → never touched by the parse (per-key permanent for
 *                      the session),
 *  - `'accepted'`    → never re-opened by the parse (the mint happened).
 *
 *  Proposals are NEVER serialized into model-visible context (N.9.1) — this
 *  store backs the owner-surface rpc + the parse middleware only.
 *  Local-only; the contract store never syncs cloud (D-090/D-097/D-168).
 *
 *  Spec: D-177 § N.11 rule 5 (5.c); slice C. */

import { canonicalJSONStringify } from '@recued/crypto/canonical-json';
import {
  SCOPED_GRANT_SUGGESTION_SCOPE,
  type ScopedGrantSuggestionRow,
  type ScopedGrantSuggestionSnapshot,
} from '@recued/contracts';

import type { ContractStore } from './contract-store.js';

export type ScopedGrantSuggestionUpsertOutcome =
  | 'created'
  | 'updated'
  | 'unchanged'
  | 'suppressed';

export interface ScopedGrantSuggestionUpsertInput {
  readonly key_hash: string;
  readonly snapshot: ScopedGrantSuggestionSnapshot;
  readonly triggering_excerpt: string;
  readonly connection_candidates: ReadonlyArray<string>;
}

export type ScopedGrantSuggestionSetStateOutcome =
  | 'changed'
  | 'unchanged'
  | 'refused'
  | 'absent';

export interface ScopedGrantSuggestionStore {
  get(key_hash: string): ScopedGrantSuggestionRow | null;
  /** Every proposal row, most-recently-updated first. The card surface
   *  filters by state + session. */
  list(): ScopedGrantSuggestionRow[];
  /** The parse middleware's idempotent unique-key upsert (see the module
   *  doc's state machine). Returns what happened so the caller fans the bus
   *  event on `'created'` and stays silent otherwise. */
  upsertOpen(input: ScopedGrantSuggestionUpsertInput): ScopedGrantSuggestionUpsertOutcome;
  /** The OWNER's resolution write (accept/dismiss rpc). Legal transitions:
   *  open→accepted, open→dismissed; same-state retry is `'unchanged'`
   *  (at-least-once safety); everything else `'refused'`, fail closed. */
  setState(
    key_hash: string,
    next: 'accepted' | 'dismissed',
  ): { outcome: ScopedGrantSuggestionSetStateOutcome; row: ScopedGrantSuggestionRow | null };
}

export interface CreateScopedGrantSuggestionStoreOptions {
  /** Clock (epoch-ms) for `created_at` / `updated_at`. Tests inject. */
  now?: () => number;
}

/** Wrap a {@link ContractStore} as the {@link ScopedGrantSuggestionStore}.
 *  Stateless beyond the injected clock — safe to construct more than once
 *  over the same store. */
export const createScopedGrantSuggestionStore = (
  store: ContractStore,
  opts?: CreateScopedGrantSuggestionStoreOptions,
): ScopedGrantSuggestionStore => {
  const now = opts?.now ?? ((): number => Date.now());

  const read = (key_hash: string): ScopedGrantSuggestionRow | null => {
    const row = store.get(SCOPED_GRANT_SUGGESTION_SCOPE, [key_hash]);
    return row ? (row.value as ScopedGrantSuggestionRow) : null;
  };

  return {
    get(key_hash) {
      return read(key_hash);
    },

    list() {
      return store
        .scan(SCOPED_GRANT_SUGGESTION_SCOPE)
        .map((row) => row.value as ScopedGrantSuggestionRow)
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
        const row: ScopedGrantSuggestionRow = {
          key_hash: input.key_hash,
          state: 'open',
          snapshot: input.snapshot,
          triggering_excerpt: input.triggering_excerpt,
          connection_candidates: [...input.connection_candidates],
          created_at: at,
          updated_at: at,
        };
        store.put(SCOPED_GRANT_SUGGESTION_SCOPE, [input.key_hash], row);
        return 'created';
      }
      // Terminal-for-the-parse states — a human resolution is never
      // overridden by a re-utterance (dismissed is per-key permanent for the
      // session; accepted marks the mint). Unknown future state vocabulary
      // suppresses the same way (fail closed).
      if (existing.state !== 'open') return 'suppressed';
      if (
        canonicalJSONStringify(existing.snapshot) === canonicalJSONStringify(input.snapshot)
        && existing.triggering_excerpt === input.triggering_excerpt
        && canonicalJSONStringify(existing.connection_candidates)
          === canonicalJSONStringify(input.connection_candidates)
      ) {
        return 'unchanged';
      }
      const updated: ScopedGrantSuggestionRow = {
        ...existing,
        snapshot: input.snapshot,
        triggering_excerpt: input.triggering_excerpt,
        connection_candidates: [...input.connection_candidates],
        updated_at: now(),
      };
      store.put(SCOPED_GRANT_SUGGESTION_SCOPE, [input.key_hash], updated);
      return 'updated';
    },

    setState(key_hash, next) {
      const existing = read(key_hash);
      if (existing === null) return { outcome: 'absent', row: null };
      if (existing.state === next) return { outcome: 'unchanged', row: existing };
      if (existing.state !== 'open') return { outcome: 'refused', row: existing };
      const updated: ScopedGrantSuggestionRow = {
        ...existing,
        state: next,
        updated_at: now(),
      };
      store.put(SCOPED_GRANT_SUGGESTION_SCOPE, [key_hash], updated);
      return { outcome: 'changed', row: updated };
    },
  };
};
