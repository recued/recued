/** D-202 Slice 1b — the LIVE capture of quality VERDICT signals at the preflight
 *  answer path.
 *
 *  Slice 1a built the reject-driven learner + its durable signal store, but
 *  nothing WROTE a signal — the learner ran over seeded rows only. This is the
 *  writer: when the owner resolves a QUALITY-relevant ask (the commit Gateway's
 *  `quality_not_delegated` verdict, carried on `Checkpoint.quality_relevant`),
 *  the resumer calls {@link captureQualityDelegationSignal} to `append` one
 *  {@link QualityDelegationSignal} — approve → `quality_good`, reject →
 *  `quality_bad` (the two DEFAULT reasons; only defaults train, §12.3). Those are
 *  precisely the asks a quality delegation would remove, so the owner's own
 *  reviews are the non-circular learning signal (seam contract §2).
 *
 *  ── Why an explicit write exists (contrast D-177) ──
 *  A D-177 `allow_session` approval MINTS a durable `grant_kind:'session'` row —
 *  the grant IS the learner's signal. A D-202 approve/reject mints no grant (a
 *  quality delegation is standing, minted only by the owner via the accept flow),
 *  so the verdict must be recorded explicitly here.
 *
 *  ── Robustness posture ──
 *  BEST-EFFORT + NEVER THROWS: a signal is statistical telemetry for the learner,
 *  never load-bearing for the resume/deny. A store failure is swallowed with a
 *  warning so it can never break the owner's actual approval. IDEMPOTENT: the
 *  `signal_id` is DETERMINISTIC (keyed on the checkpoint id — one checkpoint is
 *  one ask is one resolution), so an at-least-once boot-sweep redelivery overwrites
 *  the same row identically rather than double-counting (the store's keyed `put`
 *  is a plain append — same id ⇒ same row). FAIL-CLOSED on an unkeyable signal:
 *  a resolution missing the recipe identity or the dispatched ingredient can't
 *  faithfully key a `(recipe, op)` suggestion (mirrors {@link qualityDelegationSignalKey}),
 *  so it is skipped rather than recorded under a partial key.
 *
 *  Spec: D-202 §2 (signals) + D-202 §3 (S4). */

import type { Checkpoint, QualityDelegationSignal } from '@recued/contracts';
import type { AuditEntry } from '@recued/storage';

import type { QualityDelegationSignalStore } from './storage/quality-delegation-signal-store.js';

/** The owner's answer, mapped to a DEFAULT quality reason. `resumeRun` (approve /
 *  allow_session) → `quality_good`; `denyRun` (reject) → `quality_bad`. The two
 *  override reasons (`policy` / `ship_anyway`) are reserved for the richer render
 *  (D-200 Slice 4) — v1's live capture stamps only defaults (§13). */
export type QualityVerdictOutcome = 'approve' | 'reject';

/** Record one quality verdict signal for a resolved quality-relevant ask. Reads
 *  the `(recipe, op)` identity off the consumed `checkpoint` (`recipe_id` +
 *  `approved_target`) + the paused `anchor` (`recipe_hash` + the run's
 *  `channel_session_id`, the distinct-session provenance the learner floors on) —
 *  the SAME identity the gate matched a quality delegation against, so the signal
 *  aggregates under the key a future delegation would occupy. No-op unless the
 *  checkpoint is `quality_relevant`. Never throws. */
export const captureQualityDelegationSignal = (
  deps: { signalStore: QualityDelegationSignalStore },
  input: {
    checkpoint: Checkpoint;
    /** The paused run's audit anchor — the source of `recipe_hash` and the run's
     *  `channel_session_id`. */
    anchor: AuditEntry;
    /** The owner's answer. */
    outcome: QualityVerdictOutcome;
    /** Event time (epoch-ms) — the durably-recorded answer time when known
     *  (approve carries `PreflightAskContext.approved_at`), else the resolve
     *  clock. */
    at: number;
  },
): void => {
  const { checkpoint, anchor, outcome, at } = input;
  try {
    // Only a `quality_not_delegated` ask trains the quality axis. A non-quality
    // checkpoint (undefined / false) records nothing — behaviour-preserving.
    if (checkpoint.quality_relevant !== true) return;

    const recipe_id = checkpoint.recipe_id ?? anchor.recipe_id;
    const recipe_hash = anchor.recipe_hash;
    const ingredient_id = checkpoint.approved_target?.ingredient_slug;
    // Fail closed: a signal that can't key a `(recipe, op)` suggestion is inert
    // and would only pollute the store. Mirrors `qualityDelegationSignalKey`'s
    // own non-empty gate (recipe identity + ingredient are the coarse key).
    if (
      typeof recipe_id !== 'string' || recipe_id.length === 0
      || typeof recipe_hash !== 'string' || recipe_hash.length === 0
      || typeof ingredient_id !== 'string' || ingredient_id.length === 0
    ) {
      return;
    }

    const operation_id = checkpoint.approved_target?.operation_id;
    const signal: QualityDelegationSignal = {
      // Deterministic on the checkpoint id → an at-least-once redelivery
      // overwrites the same row (never double-counts). One checkpoint is one
      // ask is one resolution.
      signal_id: `qds_${checkpoint.checkpoint_id}`,
      recipe_id,
      recipe_hash,
      ingredient_id,
      ...(typeof operation_id === 'string' && operation_id.length > 0
        ? { operation_id }
        : {}),
      // The run's channel session — the distinct-session floor counts these, so
      // one session's repeated approves cannot alone earn the offer (mirrors the
      // D-177 learner's `channel_session_id` provenance). Empty when the source
      // carried no session (a non-chat run): such a signal counts toward the raw
      // approve total but not the distinct-session floor, so it can never alone
      // qualify — the acceptable fail-closed direction.
      channel_session_id: anchor.channel_session_id ?? '',
      reason: outcome === 'approve' ? 'quality_good' : 'quality_bad',
      at,
      // Audit back-pointer — the paused run. Surfaced in the suggestion evidence
      // sample; never load-bearing for the threshold.
      audit_ref: checkpoint.run_id,
    };
    deps.signalStore.append(signal);
  } catch (error) {
    // Best-effort telemetry — a signal failure must never break the resume/deny.
    console.warn(
      `[quality-signal-capture] failed to record a ${outcome} verdict for `
        + `run_id=${checkpoint.run_id} checkpoint=${checkpoint.checkpoint_id}: `
        + (error instanceof Error ? error.message : String(error)),
    );
  }
};
