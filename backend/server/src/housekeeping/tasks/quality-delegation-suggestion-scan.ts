/** D-202 Slice 1 — `quality-delegation-suggestion-scan` housekeeping task: the
 *  reject-driven quality LEARNER (the SOURCE that makes the quality axis suggest
 *  a delegation; today nothing does — the owner mints only manually).
 *
 *  The quality-axis analogue of the D-177 `delegation-rule-suggestion-scan`, but
 *  over an EXPLICIT signal (a quality reject mints no grant, so there is no
 *  `grant_kind:'session'` row to aggregate — see `quality-delegation-signal.ts`).
 *  It reads the durable {@link QualityDelegationSignal} verdicts, aggregates them
 *  by the canonical `(recipe, op)` key, evaluates the reject-driven threshold
 *  ({@link evaluateQualityDelegationSuggestionGroup} — default-reason approves
 *  since the last reject, ≥ threshold spanning ≥ threshold distinct sessions),
 *  joins the quality-delegation suppression (an existing grant on the key —
 *  REVOKED ⇒ durable distrust, LIVE ⇒ already operating; both suppress), and
 *  upserts `contract.quality_delegation_suggestion.<key_hash>` rows through the
 *  state-machine-enforcing store (dismissed/accepted rows are never re-opened).
 *
 *  RECOMPUTE-ALL, not a dirty-window: the window + reject-knockdown mean a group's
 *  verdict can change with no new signal (a reject ages out of the 30 d window, or
 *  the newest reject's approves re-accumulate), so every cycle recomputes. The
 *  signal table is human-paced (one row per owner verdict), every upsert is
 *  change-gated at the store, so the full recompute is idempotent + effectively
 *  free. The steady-state cursor records the high-water verdict `at` as a
 *  progress marker; it does NOT gate the recompute. Runs on idle cycles only —
 *  the gate hot path never counts (mirrors N.9.8).
 *
 *  Budget fairness: groups are evaluated in KEY-HASH order; a budget yield returns
 *  a `'topic'`-kind resume cursor carrying the last hash processed, so the next
 *  slice continues from there rather than re-walking the same head groups. Reaching
 *  the end completes the run (head groups a mid-list resume skipped are covered by
 *  the next cycle's fresh recompute).
 *
 *  Suggestions never reach model-visible context: the learner writes rows only.
 *  (A realtime `contract.quality_delegation_suggested` bus event — so `#contracts`
 *  refreshes the "Quality auto-accept" card live rather than on re-list — is a
 *  deferred polish; the D-177 event is itself best-effort, recovered by re-list.)
 *
 *  Spec: D-202 §2 (signals) / §6 / §8 / §12.3. */

import {
  QUALITY_DELEGATION_SUGGESTION_SCAN_TASK_ID,
  deriveQualityDelegationKeyFromGrant,
  evaluateQualityDelegationSuggestionGroup,
  isContractActive,
  qualityDelegationSignalKey,
  qualityDelegationSuggestionKeyHash,
  type QualityDelegationSignal,
  type QualityDelegationSuggestionSnapshot,
  type HousekeepingCursor,
  type HousekeepingStepResult,
} from '@recued/contracts';

import type { HousekeepingContext, HousekeepingTaskInstance } from '../registry.js';
import type { ContractDefinitionStore } from '../../storage/contract-definition-store.js';
import type { QualityDelegationSignalStore } from '../../storage/quality-delegation-signal-store.js';
import type { QualityDelegationSuggestionStore } from '../../storage/quality-delegation-suggestion-store.js';

export interface QualityDelegationSuggestionScanDeps {
  /** The `contract.quality_delegation_signal.*` store — the durable verdicts the
   *  learner aggregates (its SIGNAL). */
  signalStore: QualityDelegationSignalStore;
  /** The `contract.contract_definition.*` lifecycle store — the learner reads
   *  minted quality delegations off it for the suppression join. */
  definitionStore: ContractDefinitionStore;
  /** The `contract.quality_delegation_suggestion.*` store — the UNIQUE-key upsert
   *  target; enforces the open/accepted/dismissed state machine. */
  suggestionStore: QualityDelegationSuggestionStore;
}

/** One aggregated `(recipe, op)` group mid-scan. */
interface KeyGroup {
  snapshot: QualityDelegationSuggestionSnapshot;
  signals: QualityDelegationSignal[];
  /** `at` of the newest signal whose key snapshot is kept (canonically identical
   *  across the group by construction; the freshest verdict's shape wins). */
  snapshot_at: number;
}

const cursorLastSeenAt = (cursor: HousekeepingCursor): number =>
  cursor.kind === 'time' ? cursor.last_seen_at : 0;

/** The mid-recompute resume point a budget yield persisted: the last key hash
 *  processed, carried on a `'topic'`-kind cursor. Any other cursor kind (the
 *  steady-state `'time'` marker, a fresh start) resumes from the top. */
const cursorResumeAfterHash = (cursor: HousekeepingCursor): string | undefined =>
  cursor.kind === 'topic'
    && cursor.topic === QUALITY_DELEGATION_SUGGESTION_SCAN_TASK_ID
    && cursor.max_target_id_seen.length > 0
    ? cursor.max_target_id_seen
    : undefined;

/** Build the scan-task instance bound to the three contract-substrate stores. The
 *  housekeeping composer registers it when the contract store is composed (dbless
 *  harnesses skip it); tests construct it directly. */
export const buildQualityDelegationSuggestionScanTask = (
  deps: QualityDelegationSuggestionScanDeps,
): HousekeepingTaskInstance => ({
  meta: {
    id: QUALITY_DELEGATION_SUGGESTION_SCAN_TASK_ID,
    description:
      'Aggregate repeated default-reason quality approvals into (recipe, op) quality-delegation suggestions (reject-driven; owner mints — never auto-promotes).',
    interruptible: true,
    kind: 'core',
    tags: ['kind:core', 'domain:contract', 'surface:deterministic'],
  },

  async step(
    ctx: HousekeepingContext,
    cursor: HousekeepingCursor,
    budget_ms: number,
  ): Promise<HousekeepingStepResult> {
    const start = ctx.now();
    const nowMs = start;
    const priorHighWater = cursorLastSeenAt(cursor);

    // ── Signal: every quality verdict row.
    const signals = deps.signalStore.list();
    if (signals.length === 0) {
      return {
        status: 'complete',
        cursor: { kind: 'time', last_seen_at: priorHighWater },
      };
    }

    // ── Suppression join: an existing quality delegation occupies/poisons its
    //    key. REVOKED ⇒ durable distrust (never re-suggest); LIVE ⇒ already
    //    operating (a suggestion would be noise). An EXPIRED, non-revoked grant
    //    suppresses nothing — natural decay is not distrust (quality delegations
    //    are usually standing, so this is rare; kept for symmetry with D-177).
    const suppressedKeys = new Set<string>();
    for (const grant of deps.definitionStore.listQualityDelegations()) {
      const key = deriveQualityDelegationKeyFromGrant(grant);
      if (key === undefined) continue; // underivable rows can't join — fail closed
      const revoked = grant.revoked_at !== undefined && grant.revoked_at !== null;
      if (revoked || isContractActive(grant, nowMs)) {
        suppressedKeys.add(qualityDelegationSuggestionKeyHash(key));
      }
    }

    // ── Aggregate by the canonical (recipe, op) key. Underivable signals
    //    (missing recipe identity / ingredient) derive no key and don't count —
    //    the fail-closed posture of the key projection.
    const groups = new Map<string, KeyGroup>();
    let highWater = priorHighWater;
    for (const signal of signals) {
      if (signal.at > highWater) highWater = signal.at;
      const key = qualityDelegationSignalKey(signal);
      if (key === undefined) continue;
      const hash = qualityDelegationSuggestionKeyHash(key);
      const group = groups.get(hash);
      if (group === undefined) {
        groups.set(hash, { snapshot: key, signals: [signal], snapshot_at: signal.at });
      } else {
        group.signals.push(signal);
        // Keep the newest signal's key snapshot (canonically identical across the
        // group by key construction; the freshest verdict's verbatim shape wins).
        if (signal.at > group.snapshot_at) {
          group.snapshot = key;
          group.snapshot_at = signal.at;
        }
      }
    }

    // ── Evaluate + upsert in KEY-HASH order, budget-checked between groups (a
    //    deterministic order + resume marker keep a tight budget from re-walking
    //    the same head groups; the recompute itself is idempotent at the store).
    const resumeAfter = cursorResumeAfterHash(cursor);
    const sortedHashes = [...groups.keys()].sort();
    let lastProcessedHash = resumeAfter;
    let yieldedForBudget = false;
    for (const hash of sortedHashes) {
      if (resumeAfter !== undefined && hash <= resumeAfter) continue;
      if (ctx.now() - start >= budget_ms) {
        yieldedForBudget = true;
        break;
      }
      lastProcessedHash = hash;
      if (suppressedKeys.has(hash)) continue;
      const group = groups.get(hash)!;
      const verdict = evaluateQualityDelegationSuggestionGroup(group.signals, nowMs);
      if (!verdict.qualifies) continue;
      deps.suggestionStore.upsertOpen({
        key_hash: hash,
        snapshot: group.snapshot,
        evidence: verdict.evidence,
      });
    }

    if (yieldedForBudget) {
      return {
        status: 'yield',
        reason: 'budget_exhausted',
        cursor: {
          kind: 'topic',
          topic: QUALITY_DELEGATION_SUGGESTION_SCAN_TASK_ID,
          max_target_id_seen: lastProcessedHash ?? '',
        },
      };
    }
    // End of the sorted list — the run is complete. Head groups a mid-list resume
    // skipped are covered by the next cycle's fresh recompute; the steady-state
    // cursor reverts to the verdict-`at` high-water marker.
    return {
      status: 'complete',
      cursor: { kind: 'time', last_seen_at: highWater },
    };
  },
});
