/** D-145 PB2 — RecuedPlan storage shim.
 *
 *  Persists D-120 memory entries of kind `recued_plan` per § B.5.3.
 *  Engine already emits to memory (audit + links); this is a richer
 *  entry kind backed by its own collection so plan retrieval doesn't
 *  scan audit_entries blob-style.
 *
 *  Two storage backings exist (parallel to the audit / recipe-insights
 *  pattern):
 *
 *    - **Server SQLite** — primary path. Per § B.5.3 plans land as a
 *      JSON payload row keyed on `plan_id` with `event_at` =
 *      `started_at` (D-120 P7.5 bistemporal stamping).
 *    - **In-memory / IDB** — test + extension paths.
 *
 *  Both produce byte-identical `RecuedPlan` shapes; the runtime
 *  validator (`assertValidRecuedPlan`) gates every write. The
 *  signature path lives in `backend/server/src/recued-plan/signing.ts`
 *  alongside the existing audit signing primitive — same Ed25519 +
 *  canonical-JSON pattern, same `server_identity_key`. The store
 *  itself is signature-agnostic; callers stamp the signature before
 *  handing the plan to `append()`.
 *
 *  PB2 ships the shim. PB3 wires the orchestrator's `memory.write`
 *  primitive to call it; PB7 wires the Transparency Stream renderer
 *  to consume `user_visible_internal_steps`.
 *
 *  Spec: D-145 § B.5. */

import {
  RECUED_PLAN_MEMORY_KIND,
  assertValidRecuedPlan,
  type RecuedPlan,
} from '@recued/contracts';
import type { Collection } from './types.js';

/** Memory-entry-kind constant re-exported here so storage-side callers
 *  don't need a contracts import for this single string. Kept in
 *  contracts as the source of truth. */
export const RECUED_PLAN_KIND = RECUED_PLAN_MEMORY_KIND;

/** Optional listing window. Mirrors the audit-store pattern. */
export interface RecuedPlanListOptions {
  /** Newest-first when omitted; oldest-first when 'asc'. */
  order?: 'desc' | 'asc';
  /** Cap on the number of rows returned. Caller paginates with
   *  `since` / `until` for windowed reads. */
  limit?: number;
  /** Inclusive lower bound on `started_at` (unix-ms). */
  since?: number;
  /** Exclusive upper bound on `started_at` (unix-ms). */
  until?: number;
  /** Filter to a specific goal_id. */
  goal_id?: string;
  /** Filter to a specific status. */
  status?: RecuedPlan['status'];
}

/** Public surface of the RecuedPlan store.
 *
 *  Read-time verification is caller-responsibility (matches the
 *  audit-store pattern at `packages/storage/src/audit.ts`). `get` /
 *  `list` return persisted plan content directly without verifying
 *  the signature.
 *
 *  ⛔⛔ CORRECTED 2026-09-15 — THIS DESCRIBED WIRING THAT DOES NOT EXIST.
 *  It said "PB3's orchestrator wires verification at the replay + Dry Run
 *  preview sites where the trust gate is load-bearing; UI surfaces that
 *  render plan rows surface tampered rows visually." `verifyRecuedPlan`
 *  has ZERO production callers — its only non-definition references are
 *  `isRecuedPlanTampered` (also uncalled) and this file's comments. No
 *  orchestrator wires it, no surface renders a tamper state.
 *  ⇒ Read `backend/server/src/recued-plan/signing.ts` before assuming a
 *  plan row carries a verified trust signal; it does not. (Original note:
 *  Codex P1 #2 from the PB2 review — read-time verification as caller
 *  responsibility, consistent with the audit pattern. That design choice
 *  stands; only the claim that it was wired was false.) */
export interface RecuedPlanStore {
  /** Persist a plan. Validates shape via `assertValidRecuedPlan` —
   *  throws `RecuedPlanValidationError` on issues. Idempotent on
   *  `plan_id`: re-`append` overwrites (PB3's Dry Run commit path
   *  re-appends with the post-confirm result). */
  append(plan: RecuedPlan): Promise<void>;
  /** Fetch one plan by id, or null when missing. Does NOT verify
   *  the signature. ⛔ No production caller verifies it either — the
   *  "high-assurance callers call `verifyRecuedPlan`" this used to
   *  assert do not exist (see the header). */
  get(plan_id: string): Promise<RecuedPlan | null>;
  /** List plans matching the optional window. Default: newest-first,
   *  no cap. Does NOT verify signatures; high-assurance callers
   *  filter / verify at read time. */
  list(opts?: RecuedPlanListOptions): Promise<RecuedPlan[]>;
  /** Total stored plan count. */
  size(): Promise<number>;
  /** Delete one plan by id. Returns true when a row was removed. */
  delete(plan_id: string): Promise<boolean>;
  /** Delete every plan whose `started_at` falls before `cutoff_ms`.
   *  The audit-policy `retain_for_days` is per-plan; the caller-side
   *  retention pruner derives the cutoff per-plan. Returns the
   *  number of rows removed. */
  clearOlderThan(cutoff_ms: number): Promise<number>;
  /** Delete every plan. Use only for explicit user reset. */
  clearAll(): Promise<void>;
}

const sortByStartedAtDesc = (a: RecuedPlan, b: RecuedPlan): number =>
  b.started_at - a.started_at;
const sortByStartedAtAsc = (a: RecuedPlan, b: RecuedPlan): number =>
  a.started_at - b.started_at;

/** Build a `RecuedPlanStore` over an arbitrary `Collection`. Use with
 *  `createIDBCollection<RecuedPlan>({ dbName: 'recued-plans' })` for
 *  production; with `createInMemoryCollection<RecuedPlan>()` in tests.
 *
 *  Server-side (SQLite) callers can wrap this around a SQLite-backed
 *  Collection so plans persist to disk; the runtime validator gate
 *  is identical across backings. */
export const createRecuedPlanStore = (
  backing: Collection<RecuedPlan>,
): RecuedPlanStore => {
  return {
    async append(plan) {
      assertValidRecuedPlan(plan);
      await backing.set(plan.plan_id, plan);
    },

    async get(plan_id) {
      return backing.get(plan_id);
    },

    async list(opts = {}) {
      const all = await backing.list();
      let filtered = all;
      if (opts.since !== undefined) {
        const lo = opts.since;
        filtered = filtered.filter((p) => p.started_at >= lo);
      }
      if (opts.until !== undefined) {
        const hi = opts.until;
        filtered = filtered.filter((p) => p.started_at < hi);
      }
      if (opts.goal_id !== undefined) {
        const id = opts.goal_id;
        filtered = filtered.filter((p) => p.goal_id === id);
      }
      if (opts.status !== undefined) {
        const status = opts.status;
        filtered = filtered.filter((p) => p.status === status);
      }
      filtered.sort(opts.order === 'asc' ? sortByStartedAtAsc : sortByStartedAtDesc);
      if (opts.limit !== undefined && opts.limit >= 0) {
        return filtered.slice(0, opts.limit);
      }
      return filtered;
    },

    async size() {
      return backing.size();
    },

    async delete(plan_id) {
      const existing = await backing.get(plan_id);
      if (!existing) return false;
      await backing.delete(plan_id);
      return true;
    },

    async clearOlderThan(cutoff_ms) {
      const all = await backing.list();
      let removed = 0;
      for (const plan of all) {
        if (plan.started_at < cutoff_ms) {
          await backing.delete(plan.plan_id);
          removed++;
        }
      }
      return removed;
    },

    async clearAll() {
      const all = await backing.list();
      for (const plan of all) {
        await backing.delete(plan.plan_id);
      }
    },
  };
};
