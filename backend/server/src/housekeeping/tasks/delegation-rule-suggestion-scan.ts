/** D-177 N.13 (P6b) — `delegation-rule-suggestion-scan` housekeeping task:
 *  the staged-trust LEARNER (ladder 6, passive).
 *
 *  Aggregates the durable `grant_kind: 'session'` rows (the only signal —
 *  fork 5: every `allow_session` answer is one row carrying the complete
 *  would-be-rule key; `uses_remaining < max_uses` proves a repeat dispatch
 *  actually rode the grant) by the canonical N.13 key, evaluates the
 *  threshold (≥ 3 qualifying rows spanning ≥ 3 distinct sessions within
 *  30 d, ≥ 1 consumed use each, no revoked grant on the key), joins the
 *  delegation-rule suppression (an existing rule on the key — REVOKED ⇒
 *  durable distrust, LIVE ⇒ already operating; both suppress), and upserts
 *  `contract.delegation_rule_suggestion.<key_hash>` rows through the
 *  state-machine-enforcing store (dismissed/accepted rows are never
 *  re-opened). A `'created'` upsert fans the
 *  `contract.delegation_rule_suggested` bus event (best-effort); refreshes
 *  are silent.
 *
 *  RECOMPUTE-ALL, not a dirty-window: consumption moves `uses_remaining`
 *  WITHOUT moving `minted_at` (the mint-time resume proceeds on the approval
 *  itself — the grant's first consumption is a LATER repeat dispatch,
 *  arbitrarily delayed), so a key can cross the threshold with no new mint
 *  at all. The contract table is tiny (the store doc's ~45–175 rows,
 *  human-paced growth), every write is change-gated at the store, and the
 *  bus emit fires on row CREATION only — so the full recompute is idempotent
 *  and effectively free. The steady-state cursor records the high-water
 *  `minted_at` as a progress/observability marker (the spec's "cursor over
 *  session rows by minted_at"); it deliberately does NOT gate the recompute.
 *  N.9.8 holds: this task runs on idle cycles only — the gate hot path never
 *  counts.
 *
 *  Budget fairness (codex LOW fold): groups are evaluated in KEY-HASH order
 *  and a budget yield returns a `'topic'`-kind resume cursor carrying the
 *  last hash processed, so the next slice continues from there instead of
 *  re-walking the same head groups forever. Reaching the end of the sorted
 *  list completes the run (head groups skipped by a mid-list resume are
 *  covered by the next cycle's fresh recompute — every group is evaluated
 *  within two completed cycles regardless of budget).
 *
 *  Suggestions never reach model-visible context (N.9.1): the learner writes
 *  rows + fans a key-hash-only bus event; rendering is the P6c owner panel.
 *
 *  Spec: D-177 § N.13; landing order P6b. */

import {
  DELEGATION_RULE_SUGGESTION_SCAN_TASK_ID,
  delegationRuleSuggestionKeyHash,
  deriveDelegationRuleSuggestionKey,
  evaluateDelegationRuleSuggestionGroup,
  isContractActive,
  type ContractDefinition,
  type DelegationRuleSuggestionSnapshot,
  type HousekeepingCursor,
  type HousekeepingStepResult,
} from '@recued/contracts';

import type {
  HousekeepingContext,
  HousekeepingTaskInstance,
} from '../registry.js';
import type { ContractDefinitionStore } from '../../storage/contract-definition-store.js';
import type { DelegationSuggestionStore } from '../../storage/delegation-suggestion-store.js';
import type { EventBus } from '../../events/bus.js';

export interface DelegationRuleSuggestionScanDeps {
  /** The `contract.contract_definition.*` lifecycle store — the learner reads
   *  session rows (signal) + delegation rules (suppression join) off it. */
  definitionStore: ContractDefinitionStore;
  /** The `contract.delegation_rule_suggestion.*` store — the UNIQUE-key
   *  upsert target; enforces the open/accepted/dismissed state machine. */
  suggestionStore: DelegationSuggestionStore;
  /** Optional realtime bus — a `'created'` upsert fans
   *  `contract.delegation_rule_suggested` (best-effort; missed events
   *  recover from the bus ring / the panel's re-list). Tests pass a
   *  recorder; production wires the real bus. */
  eventBus?: EventBus;
}

/** One aggregated key group mid-scan. */
interface KeyGroup {
  snapshot: DelegationRuleSuggestionSnapshot;
  rows: ContractDefinition[];
  /** `minted_at` of the row whose snapshot is kept (the NEWEST row's — the
   *  most recent approval's verbatim shape wins when a group accumulates). */
  snapshot_minted_at: number;
}

const cursorLastSeenAt = (cursor: HousekeepingCursor): number =>
  cursor.kind === 'time' ? cursor.last_seen_at : 0;

/** The mid-recompute resume point a budget yield persisted (codex LOW fold):
 *  the last key hash processed, carried on a `'topic'`-kind cursor. Any
 *  other cursor kind (the steady-state `'time'` marker, a fresh start)
 *  resumes from the top. */
const cursorResumeAfterHash = (cursor: HousekeepingCursor): string | undefined =>
  cursor.kind === 'topic'
    && cursor.topic === DELEGATION_RULE_SUGGESTION_SCAN_TASK_ID
    && cursor.max_target_id_seen.length > 0
    ? cursor.max_target_id_seen
    : undefined;

/** Build the scan-task instance bound to the two contract-substrate stores.
 *  The housekeeping composer registers it when the contract store is
 *  composed (dbless harnesses skip it); tests construct it directly. */
export const buildDelegationRuleSuggestionScanTask = (
  deps: DelegationRuleSuggestionScanDeps,
): HousekeepingTaskInstance => ({
  meta: {
    id: DELEGATION_RULE_SUGGESTION_SCAN_TASK_ID,
    description:
      'Aggregate repeated session-grant approvals into bounded delegation-rule suggestions (deterministic; owner mints — never auto-promotes).',
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

    // ── Signal: every session-grant row (dead rows persist by design — the
    //    evidence + revocation suppression both depend on that).
    const sessionRows = deps.definitionStore
      .list()
      .filter((def) => def.grant_kind === 'session');
    if (sessionRows.length === 0) {
      return {
        status: 'complete',
        cursor: { kind: 'time', last_seen_at: priorHighWater },
      };
    }

    // ── Suppression join: existing delegation rules occupy/poison their key.
    //    Revoked ⇒ durable distrust (never re-suggest); LIVE ⇒ the rule
    //    already operates (a suggestion would be noise). An EXPIRED/EXHAUSTED
    //    non-revoked rule suppresses nothing — natural decay is not distrust,
    //    and by rule-TTL = lookback alignment the pre-mint evidence has aged
    //    out, so a re-suggestion needs genuinely fresh repeats.
    const revokedRuleKeys = new Set<string>();
    const liveRuleKeys = new Set<string>();
    for (const rule of deps.definitionStore.listDelegationRules()) {
      const ruleKey = deriveDelegationRuleSuggestionKey(rule);
      if (ruleKey === undefined) continue; // underivable rows can't join — fail closed
      const hash = delegationRuleSuggestionKeyHash(ruleKey);
      if (rule.revoked_at !== undefined && rule.revoked_at !== null) {
        revokedRuleKeys.add(hash);
      } else if (isContractActive(rule, nowMs)) {
        liveRuleKeys.add(hash);
      }
    }

    // ── Aggregate by the canonical key. Underivable rows (batch mode,
    //    multi-valued axes, admin tier, missing bindings, …) derive no key
    //    and simply don't count — the fail-closed posture of the derivation.
    const groups = new Map<string, KeyGroup>();
    let highWater = priorHighWater;
    for (const row of sessionRows) {
      if (row.minted_at > highWater) highWater = row.minted_at;
      const key = deriveDelegationRuleSuggestionKey(row);
      if (key === undefined) continue;
      const hash = delegationRuleSuggestionKeyHash(key);
      const group = groups.get(hash);
      if (group === undefined) {
        groups.set(hash, {
          snapshot: key,
          rows: [row],
          snapshot_minted_at: row.minted_at,
        });
      } else {
        group.rows.push(row);
        // Keep the NEWEST row's snapshot — canonically identical across the
        // group by key construction; the freshest approval's verbatim JSON
        // wins for the stored open_projection structure.
        if (row.minted_at > group.snapshot_minted_at) {
          group.snapshot = key;
          group.snapshot_minted_at = row.minted_at;
        }
      }
    }

    // ── Evaluate + upsert in KEY-HASH order, budget-checked between groups
    //    (codex LOW fold — deterministic order + a resume marker keep a
    //    tight budget from re-walking the same head groups every slice; the
    //    recompute itself stays idempotent, so a resumed slice that re-runs
    //    is only ever a no-op against the store's change-gating).
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
      if (revokedRuleKeys.has(hash) || liveRuleKeys.has(hash)) continue;
      const group = groups.get(hash)!;
      const verdict = evaluateDelegationRuleSuggestionGroup(group.rows, nowMs);
      if (!verdict.qualifies) continue;
      const outcome = deps.suggestionStore.upsertOpen({
        key_hash: hash,
        snapshot: group.snapshot,
        evidence: verdict.evidence,
      });
      if (outcome === 'created') {
        try {
          deps.eventBus?.emit({
            kind: 'contract.delegation_rule_suggested',
            key_hash: hash,
            ingredient_id: group.snapshot.ingredient_id,
            ...(group.snapshot.operation_id !== undefined
              ? { operation_id: group.snapshot.operation_id }
              : {}),
          });
        } catch { /* bus emit is best-effort */ }
      }
    }

    if (yieldedForBudget) {
      return {
        status: 'yield',
        reason: 'budget_exhausted',
        cursor: {
          kind: 'topic',
          topic: DELEGATION_RULE_SUGGESTION_SCAN_TASK_ID,
          max_target_id_seen: lastProcessedHash ?? '',
        },
      };
    }
    // End of the sorted list — the run is complete. Head groups a mid-list
    // resume skipped are covered by the next cycle's fresh recompute; the
    // steady-state cursor reverts to the minted_at high-water marker.
    return {
      status: 'complete',
      cursor: { kind: 'time', last_seen_at: highWater },
    };
  },
});
