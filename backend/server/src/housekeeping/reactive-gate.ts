/** D-132 Phase 3 — reactive producer trust gate.
 *
 *  Mirror of `scheduler.ts`'s `isEligibleForIdleCycle` for the reactive
 *  dispatch path. ⚠ NOT YET WIRED (verified R13 T2-Q1): no production
 *  caller consults this gate today — it is the gate the live reactive
 *  dispatcher WILL consult before firing reactive AI enrichment
 *  producers once one lands; the function is pure so the trigger-binder
 *  hook can call it identically when it does. Do not count this file as
 *  an enforcement point until a caller exists.
 *
 *  Today's three reactive producers (`contact_timeline_rollup`,
 *  `calendar_event_rollup`, `meeting_reschedule_pattern`) are
 *  deterministic — callers pass `isAiSurface: false`, the gate
 *  short-circuits past the pause-AI check, and the registry default
 *  trust state for reactive topics (`'auto'` per
 *  `resolveEnrichmentTrustDefault`) lets the fire proceed. The path
 *  lights up when the first AI reactive producer ships (likely A.14
 *  `topic_cluster` or A.17 `semantic_cluster` per the launch sequence).
 *
 *  One trust column for both housekeeping AND reactive AI producers
 *  per spec decision §6 — a topic that ever produces under both modes
 *  shares one trust state.
 *
 *  Spec: D-132 §A.10 (Reactive AI producer gate). */

import type Database from 'better-sqlite3';
import type { EnrichmentTopic } from '@recued/contracts';

import { isAiPaused, type TrustStore } from './trust-store.js';

export interface ReactiveGateContext {
  /** Singleton DB handle — used to read `pause_background_ai_until`
   *  from `housekeeping_config`. */
  db: Database.Database;
  /** Optional trust store. Without it the gate falls back to "always
   *  fire" (back-compat with harness setups + tests that don't thread
   *  P3 substrate). Production always wires it via `bin.ts`. */
  trustStore?: TrustStore;
  /** Caller-supplied clock — paired with `pause_background_ai_until`
   *  to evaluate whether the global pause window is active. */
  now: number;
  /** Whether the topic's reactive producer is AI-surface (chat /
   *  embeddings). Today's three reactive producers are deterministic
   *  → callers pass `false`. Future AI reactive producers stamp `true`
   *  at their dispatcher hook. */
  isAiSurface: boolean;
}

/** Reactive-side trust gate. Returns `true` iff the topic's reactive
 *  producer is allowed to fire on the current source-event.
 *
 *  Semantics, in order of precedence:
 *    - No trust store wired → `true` (back-compat).
 *    - Trust state `'auto'` runs; `'off'` / `'manual'` block. Reactive
 *      producers don't have a Run-Now equivalent, so `'manual'` for a
 *      reactive AI producer means "don't run at all until promoted".
 *    - AI-surface producers honour the global `pause_background_ai_until`
 *      window. Deterministic producers ignore the pause window — they
 *      have no AI cost, so the emergency switch is irrelevant. */
export const shouldFireReactive = (
  topic: EnrichmentTopic,
  ctx: ReactiveGateContext,
): boolean => {
  if (!ctx.trustStore) return true;
  const trust = ctx.trustStore.read(topic, ctx.isAiSurface);
  if (trust.trust_state !== 'auto') return false;
  if (ctx.isAiSurface && isAiPaused(ctx.db, ctx.now)) return false;
  return true;
};
