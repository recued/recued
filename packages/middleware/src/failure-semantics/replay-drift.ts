/** D-145 PB15 — replay drift detection.
 *
 *  Per § B.15.6. RecuedPlan replay (re-run plan against different AI
 *  tier per § B.5.4) requires the original `included_context` to be
 *  reproducible. When source data has changed (commitment fulfilled,
 *  calendar event moved, mail thread archived), replay records:
 *
 *    - `replay_metadata: { original_plan_id, replay_drift_detected:
 *       true, drift_summary: '<source_ref>: original_value vs current
 *       _value' }`
 *
 *  Two policies (caller-controlled):
 *    - **Default** — engine re-fetches current state, records drift
 *      metadata, continues with current context.
 *    - **Frozen** — caller opted into "freeze original context"; uses
 *      persisted `included_context` payloads from the original plan,
 *      bypasses live fetch. Privacy-class aware: persist_policy
 *      `'immediate_use_only'` items are NOT available (they were
 *      cleared post-response); replay with frozen context fails for
 *      plans that depended on immediate-use-only data with
 *      `replay_unsupported_privacy_class`.
 *
 *  Pure helpers — caller decides when to call.
 *
 *  Spec: § B.15.6 + § B.5.4. */

import type { ContextItem } from '@recued/contracts';

export type ReplayMode = 'refetch' | 'frozen';

export interface ReplayDriftInput {
  readonly mode: ReplayMode;
  readonly original_context: ReadonlyArray<ContextItem>;
  /** Caller-supplied (per-source_ref) — what the source currently looks
   *  like. Only items the caller decided to compare appear here;
   *  omitted source_refs are treated as "no change observed". */
  readonly current_state: ReadonlyMap<string, string>;
}

export interface DriftEntry {
  readonly source_ref: string;
  readonly original_summary: string;
  readonly current_summary: string;
}

export interface ReplayDriftOk {
  readonly kind: 'ok';
  readonly drifted_entries: ReadonlyArray<DriftEntry>;
  readonly drift_summary: string;
}

export interface ReplayDriftBlocked {
  readonly kind: 'blocked';
  readonly reason: 'replay_unsupported_privacy_class';
  readonly offending_source_refs: ReadonlyArray<string>;
}

export type ReplayDriftResult = ReplayDriftOk | ReplayDriftBlocked;

/** Check the original_context against current_state. Returns drift
 *  entries (empty when no drift) OR a blocked result when frozen mode
 *  needs an immediate-use-only item that no longer exists. */
export const detectReplayDrift = (input: ReplayDriftInput): ReplayDriftResult => {
  if (input.mode === 'frozen') {
    // Frozen mode: any immediate_use_only item is unrecoverable.
    const offending: string[] = [];
    for (const item of input.original_context) {
      if (item.persist_policy === 'immediate_use_only') {
        offending.push(item.source_ref);
      }
    }
    if (offending.length > 0) {
      return {
        kind: 'blocked',
        reason: 'replay_unsupported_privacy_class',
        offending_source_refs: offending,
      };
    }
  }

  // Refetch mode (or frozen with no privacy-blocked items): compare
  // current_state against original redacted_payload.
  //
  // Codex P2 fold (2026-05-10): persist-policy items typically carry
  // their full content behind `payload_ref` (opaque D-120 pointer) and
  // do NOT populate `redacted_payload`. Coercing the missing
  // redacted_payload to `''` produced false drift reports for normal
  // persisted context. The detector now SKIPS items that have neither
  // a `redacted_payload` nor a same-shape comparable original; callers
  // who need to compare payload_ref-backed rows must thread the
  // original snapshot via redacted_payload (or resolve the pointer
  // upstream and pass the resolved value through current_state with
  // matching original snapshots wired in).
  const drifted: DriftEntry[] = [];
  for (const item of input.original_context) {
    const current = input.current_state.get(item.source_ref);
    if (current === undefined) continue;
    // Only items that have a redacted_payload snapshot can be
    // compared substrate-side. payload_ref-only items are skipped —
    // the caller is responsible for resolving the pointer upstream
    // and feeding the resolved snapshot via `redacted_payload` (or
    // synthesizing a comparable original).
    if (item.redacted_payload === undefined) continue;
    const original = item.redacted_payload;
    if (current !== original) {
      drifted.push({
        source_ref: item.source_ref,
        original_summary: original,
        current_summary: current,
      });
    }
  }

  const drift_summary =
    drifted.length === 0
      ? 'no_drift'
      : drifted
          .map((d) => `${d.source_ref}: changed`)
          .join('; ');

  return { kind: 'ok', drifted_entries: drifted, drift_summary };
};
