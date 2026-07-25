/** D-202 Slice 1 — the `contract.quality_delegation_signal.*` store: the durable
 *  reject/approve VERDICTS the reject-driven learner reads. Each verdict is its
 *  own row (signals ACCUMULATE — they do not upsert), keyed by `signal_id` at
 *  `contract.quality_delegation_signal.<signal_id>`; the keyed `put` is a plain
 *  append, every write validated against the `quality_delegation_signal`
 *  value_shape.
 *
 *  This is the quality-axis analogue of the durable `grant_kind:'session'` rows
 *  the D-177 staged-trust learner aggregates — but a quality reject mints no
 *  grant, so the signal must be recorded explicitly (see
 *  `quality-delegation-signal.ts`).
 *
 *  Kernel-written (the Slice 1b capture at the answer path calls `append`);
 *  learner-read (the `quality-delegation-suggestion-scan` housekeeping task calls
 *  `list` on idle cycles only — never the gate hot path). Owner-internal (the
 *  scope is reserved out of MCP). Local-only — the contract store never syncs
 *  cloud (D-090/D-097/D-168).
 *
 *  Retention: v1 keeps every row (the learner windows to
 *  `QUALITY_DELEGATION_SUGGEST_LOOKBACK_MS` itself, so stale rows are inert, not
 *  wrong — the same persist-everything posture as the D-177 session rows). A
 *  lookback-window prune is a future housekeeping concern, not a correctness one.
 *
 *  Spec: D-202 §2. */

import {
  QUALITY_DELEGATION_SIGNAL_SCOPE,
  type QualityDelegationSignal,
} from '@recued/contracts';

import type { ContractStore } from './contract-store.js';

export interface QualityDelegationSignalStore {
  /** Append one verdict signal. Keyed by `signal_id`, so a re-delivered capture
   *  carrying the same id overwrites identically (at-least-once-safe), never
   *  double-counts. */
  append(signal: QualityDelegationSignal): void;
  /** Every signal row — the learner's full-recompute source. Order is
   *  unspecified; the learner groups + windows them itself. */
  list(): QualityDelegationSignal[];
}

/** Wrap a {@link ContractStore} as the {@link QualityDelegationSignalStore}.
 *  Stateless — the caller stamps `signal_id` + `at` on the signal (Slice 1b at
 *  capture; tests inject deterministic values). */
export const createQualityDelegationSignalStore = (
  store: ContractStore,
): QualityDelegationSignalStore => ({
  append(signal) {
    store.put(QUALITY_DELEGATION_SIGNAL_SCOPE, [signal.signal_id], signal);
  },

  list() {
    return store
      .scan(QUALITY_DELEGATION_SIGNAL_SCOPE)
      .map((row) => row.value as QualityDelegationSignal);
  },
});
