/** D-157 N.8 — the stale-checkpoint retention sweep (the optional,
 *  generous, days-scale staleness guard + checkpoint garbage collection).
 *
 *  A preflight gate checkpoints the run and ends the execution; the
 *  checkpoint is consumed when the user answers (D-157 § A.2). When no
 *  answer ever arrives, the row sits forever — and since the
 *  pii-ledger-in-checkpoint slice (`Checkpoint.pii_ledgers`) it can
 *  carry config/context-sourced values the run-record ensemble holds
 *  nowhere else. This sweep is the missing pruner, in two halves:
 *
 *  1. **The staleness guard** (the N.8 SHOULD; D-158 `stale_after` /
 *     O-5). An `awaiting_approval` run whose checkpoint is older than
 *     `preflight.stale_after_days` is expired: the still-open ask is
 *     cancelled (close-broadcast clears the prompt on every channel),
 *     the run anchor is retired `'failed'` with a
 *     `RECIPE_APPROVAL_TIMEOUT` error ("Re-run the recipe to try
 *     again"), and the checkpoint is deleted. This is product policy
 *     against an approval clicked months later firing into a changed
 *     world — NOT a technical timeout (D-157 TR-7 / D-158 I-5): the
 *     window is measured in days and configurable; `0` disables the
 *     guard entirely.
 *
 *  2. **Garbage collection** (the boot sweep's `orphaned` / `terminal`
 *     counters, previously "left for a follow-up retention slice").
 *     A checkpoint whose anchor is missing (orphaned), terminal (the
 *     run already completed), or superseded (the awaiting anchor points
 *     at a NEWER checkpoint) is unconsumable by construction — the
 *     resumer's at-entry guard skips all three classes — so the row is
 *     crash residue. These are deleted after a fixed 24 h grace
 *     (`GARBAGE_GRACE_MS`, generous against any in-flight write race),
 *     independent of the staleness guard's setting: deleting a dead
 *     run's leftover row is substrate hygiene, not approval policy.
 *
 *  **Never drops a real decision.** An ask the user already ANSWERED is
 *  never expired, no matter how old — the answer's dispatch (with its
 *  boot-retry loop) owns that checkpoint; the sweep defers (D-158 TR-4:
 *  the forbidden failure is silently dropping a decision the user made).
 *  The race against an answer arriving mid-sweep is closed by the
 *  block's answer/cancel serializer: the sweep proceeds only when its
 *  `cancelAsk` WINS (`'cancelled'`) or no live answer path exists (ask
 *  `handled` / missing / never raised); a lost race defers to the next
 *  tick.
 *
 *  An answer that arrives AFTER expiry hits the preflight handler's
 *  designed degrade: missing checkpoint → silent skip ("the run was
 *  reaped by a staleness guard" — preflight-reconciliation.ts).
 *
 *  Idempotent; concurrent calls coalesce into one in-flight pass
 *  (mirrors `createAuditRetention`).
 *
 *  Spec: docs/d-157-spec.md § N.8 SHOULD/MAY + docs/d-158-spec.md
 *  staleness guard (P3 / O-5). */

import type { Checkpoint, RecipeError } from '@recued/contracts';
import {
  buildAuditEntry,
  type AuditEntry,
  type AuditLogStore,
  type CheckpointStore,
} from '@recued/storage';

/** Fixed grace for the garbage-collection half — generous against any
 *  crash-window or in-flight pause write (checkpoint → raise → anchor
 *  append all happen within one request). NOT the staleness guard's
 *  knob: garbage rows are unconsumable regardless of approval policy. */
export const GARBAGE_GRACE_MS = 24 * 3_600_000;

export interface CheckpointRetentionConfig {
  /** Days an `awaiting_approval` checkpoint may sit unanswered before
   *  the staleness guard expires it. `null` disables the guard (the
   *  wire format carries `0` as the off sentinel; the composer
   *  collapses `0 → null` here — mirrors `audit.retention_days`).
   *  Garbage collection runs either way. */
  staleAfterDays: number | null;
}

/** The narrow ask-state reads the sweep needs from the notification
 *  block. Structural subset of `NotificationBlock` — the composer
 *  passes the block's own methods through. Optional as a pair: absent
 *  (db-less harness) the block was never constructed, so no inbound
 *  answer path exists and expiry proceeds without prompt bookkeeping. */
export interface CheckpointRetentionAskHooks {
  /** One durable ask row's lifecycle state + handler payload, or `null`
   *  when unknown. The payload read backs the batch-hold detection
   *  (codex BLOCKER 1 fold below). */
  getAsk(ask_id: string): Promise<{
    status: 'open' | 'answered' | 'handled';
    handler_payload: Record<string, unknown>;
  } | null>;
  /** Race-safe terminal close of a still-`open` ask + close-broadcast
   *  across its delivered channels. `'not_open'` ⇒ an answer won. */
  cancelAsk(ask_id: string): Promise<'cancelled' | 'not_open'>;
}

export interface CheckpointRetentionDeps {
  checkpointStore: CheckpointStore;
  auditLog: AuditLogStore;
  /** Ask-state hooks off the notification block. Absent ⇒ no block this
   *  process ⇒ no answer can arrive ⇒ expiry skips prompt bookkeeping. */
  askHooks?: CheckpointRetentionAskHooks;
  now?: () => number;
  /** Live config view — read on every pass so a runtime reconfigure
   *  takes effect without restart. */
  config: () => CheckpointRetentionConfig;
}

export interface CheckpointRetentionResult {
  /** Checkpoint rows the pass walked. */
  inspected: number;
  /** Awaiting runs the staleness guard expired (ask cancelled, anchor
   *  retired `'failed'`/`RECIPE_APPROVAL_TIMEOUT`, checkpoint deleted). */
  expired: number;
  /** Orphaned / terminal / superseded rows deleted past the grace. */
  garbage_collected: number;
  /** Rows left for the answer path: the ask is `answered` (a real
   *  decision mid-dispatch — never dropped) or an answer won the
   *  cancel race this instant. Re-examined next tick. */
  deferred: number;
  /** Per-row failures (I/O threw). Retried next tick. */
  failed: number;
  duration_ms: number;
}

export interface CheckpointRetention {
  run(): Promise<CheckpointRetentionResult>;
  /** Cron-ready wrapper — never throws; logs the failure as a
   *  `checkpoint_retention_prune` activity and returns `null`. */
  runSafe(): Promise<CheckpointRetentionResult | null>;
}

export const createCheckpointRetention = (
  deps: CheckpointRetentionDeps,
): CheckpointRetention => {
  let inflight: Promise<CheckpointRetentionResult> | null = null;
  const nowOf = deps.now ?? Date.now;

  /** The expiry audit row — mirrors the deny path's shape
   *  (`preflight-resumer.ts denyRun`): the same `run_id` keys the row,
   *  so INSERT OR REPLACE retires the `'awaiting_approval'` anchor to
   *  `'failed'` in one write. `recipe_hash` stays the anchor's
   *  historical hash (nothing was re-attempted now); duration spans
   *  original start → expiry, so `buildAuditEntry` reproduces the
   *  original `started_at` exactly. The terminal row drops the
   *  `checkpoint_id` / `ask_id` pairing fields, exactly like a deny. */
  const buildExpiryEntry = (
    anchor: AuditEntry,
    checkpoint: Checkpoint,
    staleAfterDays: number,
    nowMs: number,
  ): AuditEntry => {
    const staleError: RecipeError = {
      error_id: `preflight-stale-${nowMs.toString(36)}-${checkpoint.run_id}`,
      code: 'RECIPE_APPROVAL_TIMEOUT',
      message:
        `Preflight approval at step '${checkpoint.gated_step_id}' was not `
          + `answered within ${staleAfterDays} day${staleAfterDays === 1 ? '' : 's'} `
          + `— the staleness guard expired the paused run. Re-run the recipe `
          + `to try again.`,
      severity: 'error',
      source: {
        // D-182 §8 — this builder runs ONLY for a recipe checkpoint (a raw-op
        // checkpoint has no `awaiting_approval` anchor → it falls into the
        // garbage-GC branch above, never here). Read the recipe id off the
        // anchor (always present on a recipe-run `AuditEntry`); the gated step
        // id is checkpoint-only, coalesced for the recipe-less type.
        recipe_id: anchor.recipe_id,
        step_id: checkpoint.gated_step_id ?? '',
        ingredient_slug: null,
      },
      details: {
        checkpoint_id: checkpoint.checkpoint_id,
        ...(anchor.ask_id !== undefined ? { ask_id: anchor.ask_id } : {}),
        stale_after_days: staleAfterDays,
      },
      timestamp: new Date(nowMs).toISOString(),
      retryable: false,
    };
    return buildAuditEntry({
      recipe_id: anchor.recipe_id,
      recipe_hash: anchor.recipe_hash,
      commit_status: 'failed',
      duration_ms: Math.max(0, nowMs - anchor.started_at),
      errors: [staleError],
      config_snapshot: { ...anchor.config_snapshot },
      trigger_url: anchor.trigger_url ?? null,
      trigger_source: anchor.trigger_source ?? null,
      instance_id: anchor.instance_id ?? null,
      run_id: checkpoint.run_id,
      now: nowMs,
      ...(anchor.recipe_insight_id !== undefined
        ? { recipe_insight_id: anchor.recipe_insight_id }
        : {}),
      ...(anchor.backfill ? { backfill: anchor.backfill } : {}),
      ...(anchor.process_id ? { process_id: anchor.process_id } : {}),
      ...(anchor.run_mode ? { run_mode: anchor.run_mode } : {}),
      ...(anchor.execution_source
        ? { execution_source: anchor.execution_source }
        : {}),
      ...(anchor.contract_snapshot
        ? { contract_snapshot: anchor.contract_snapshot }
        : {}),
      ...(anchor.channel_session_id
        ? { channel_session_id: anchor.channel_session_id }
        : {}),
      ...(anchor.cognition_session_id
        ? { cognition_session_id: anchor.cognition_session_id }
        : {}),
      ...(anchor.correlation_id
        ? { correlation_id: anchor.correlation_id }
        : {}),
    });
  };

  const runOnce = async (): Promise<CheckpointRetentionResult> => {
    const start = nowOf();
    const cfg = deps.config();
    const staleAfterMs =
      cfg.staleAfterDays === null ? null : cfg.staleAfterDays * 86_400_000;

    const result: CheckpointRetentionResult = {
      inspected: 0,
      expired: 0,
      garbage_collected: 0,
      deferred: 0,
      failed: 0,
      duration_ms: 0,
    };

    let checkpoints: Checkpoint[];
    try {
      checkpoints = await deps.checkpointStore.list();
    } catch (e) {
      console.warn(
        '[checkpoint-retention] checkpoint list failed; skipping pass: '
          + (e instanceof Error ? e.message : String(e)),
      );
      result.duration_ms = nowOf() - start;
      return result;
    }

    for (const checkpoint of checkpoints) {
      result.inspected++;
      const age = start - checkpoint.created_at;
      // Below every threshold — the common case exits before any I/O.
      if (
        age < GARBAGE_GRACE_MS
        && (staleAfterMs === null || age < staleAfterMs)
      ) {
        continue;
      }

      let anchor: AuditEntry | null;
      try {
        anchor = await deps.auditLog.get(checkpoint.run_id);
      } catch (e) {
        console.warn(
          `[checkpoint-retention] auditLog.get(${checkpoint.run_id}) failed: `
            + (e instanceof Error ? e.message : String(e)),
        );
        result.failed++;
        continue;
      }

      if (
        anchor === null
        || anchor.commit_status !== 'awaiting_approval'
        || (anchor.checkpoint_id !== undefined
          && anchor.checkpoint_id !== checkpoint.checkpoint_id)
      ) {
        // Garbage half — orphaned (no anchor), terminal (run already
        // completed), or superseded (a newer pause owns the anchor).
        // All three are crash residue the resumer's at-entry guard
        // would skip; the row is unconsumable.
        if (age < GARBAGE_GRACE_MS) continue;
        try {
          // Best-effort zombie-prompt close: a crash between an answer
          // dispatch's skip and its checkpoint delete (or between this
          // sweep's own expiry row and its delete) can leave a live
          // card pointing at a finished run. TERMINAL anchors only —
          // a superseded-awaiting anchor's `ask_id` belongs to the
          // NEWER pause that rewrote the row in place (the live prompt
          // of a live run); cancelling it would strand that run until
          // the staleness guard, since the boot sweep skips
          // `alreadyPaired` anchors. Idempotent; `'not_open'` is the
          // normal outcome — in particular a terminal batch member's
          // anchor can point at the shared batch ask, which by then is
          // past `open` (members only resume through an answer).
          if (
            anchor !== null
            && anchor.commit_status !== 'awaiting_approval'
            && anchor.ask_id !== undefined
            && deps.askHooks !== undefined
          ) {
            try {
              await deps.askHooks.cancelAsk(anchor.ask_id);
            } catch {
              // best-effort — the checkpoint delete below is the work.
            }
          }
          await deps.checkpointStore.delete(checkpoint.checkpoint_id);
          result.garbage_collected++;
        } catch (e) {
          console.warn(
            `[checkpoint-retention] garbage delete failed for checkpoint `
              + `${checkpoint.checkpoint_id}: `
              + (e instanceof Error ? e.message : String(e)),
          );
          result.failed++;
        }
        continue;
      }

      // Staleness-guard half — awaiting anchor, current checkpoint.
      //
      // D-210 Phase C — an ASK-LESS hold falls straight past every deferral
      // below and expires. That is correct, and it is worth saying why,
      // because Phase C made ask-less holds ROUTINE (a notify-mode reception
      // hold is never given a durable ask; the webclient inbox owns its
      // lifecycle) and the obvious-looking "a party owns it, so don't expire
      // it" change is WRONG:
      //
      //   - every deferral below protects ASK bookkeeping — a batch member's
      //     lifecycle, an answered-but-undispatched ask, an open-cancel race.
      //     An ask-less hold has none of it, so there is nothing to defer TO.
      //   - staleness is ORIGIN-INDEPENDENT product policy, not a technical
      //     timeout: `preflight.stale_after_days` is documented as the guard
      //     against "an approval clicked months later firing into a changed
      //     world". A reception submission from a stranger is that risk, not
      //     an exception to it.
      //   - the owner already decides: `stale_after_days = 0` means wait
      //     forever. A hard-coded never-expire rule for one party would take
      //     that choice away AND grow checkpoints holding visitor PII without
      //     bound — the inbox implements no expiry of its own, and an awaiting
      //     anchor is exempt from both audit-retention passes precisely
      //     BECAUSE this guard is what eventually makes it terminal.
      //
      // Pinned by the two D-210 Phase C cases in `checkpoint-retention.test.ts`.
      if (staleAfterMs === null || age < staleAfterMs) continue;
      try {
        if (anchor.ask_id !== undefined && deps.askHooks !== undefined) {
          const ask = await deps.askHooks.getAsk(anchor.ask_id);
          // codex BLOCKER 1 fold — a batch-registered hold (D-177 P5a)
          // is NEVER expired through its member pointer. A join
          // re-renders the batch ask: only the JOINING run's anchor
          // gets the fresh `ask_id`; older members keep their
          // superseded (cancelled → `handled`) ask, so this row's
          // state says nothing about the LIVE batch ask still covering
          // the member — expiring on it would delete a checkpoint a
          // live prompt's approve is about to resume (a dropped
          // decision). The batch substrate owns its members' lifecycle;
          // defer unconditionally.
          if (
            ask !== null
            && typeof ask.handler_payload.batch_id === 'string'
            && ask.handler_payload.batch_id.length > 0
          ) {
            result.deferred++;
            continue;
          }
          if (ask !== null && ask.status === 'answered') {
            // A real decision awaiting (or retrying) dispatch — the
            // answer path owns this checkpoint; never drop it (D-158
            // TR-4). The dispatch consumes the checkpoint on success.
            result.deferred++;
            continue;
          }
          if (ask !== null && ask.status === 'open') {
            const outcome = await deps.askHooks.cancelAsk(anchor.ask_id);
            if (outcome === 'not_open') {
              // An answer won the serializer race this instant — its
              // dispatch proceeds; re-examine next tick.
              result.deferred++;
              continue;
            }
          }
          // `handled` / missing row / just-cancelled — no live answer
          // path can start (`submitAnswer` no-ops past `open`).
        }
        // Re-check the row immediately before retiring the anchor: an
        // answer that completed between the anchor read and here has
        // consumed the checkpoint (delete precedes `markHandled`) — a
        // gone row means the run finished; expiring it would overwrite
        // a real outcome.
        if ((await deps.checkpointStore.get(checkpoint.checkpoint_id)) === null) {
          result.deferred++;
          continue;
        }
        await deps.auditLog.append(
          buildExpiryEntry(anchor, checkpoint, cfg.staleAfterDays as number, start),
        );
        await deps.checkpointStore.delete(checkpoint.checkpoint_id);
        result.expired++;
      } catch (e) {
        console.warn(
          `[checkpoint-retention] expiry failed for run ${checkpoint.run_id}: `
            + (e instanceof Error ? e.message : String(e)),
        );
        result.failed++;
      }
    }

    result.duration_ms = nowOf() - start;

    // One reserve-class summary activity per pass that did work — the
    // forensic ledger entry (mirrors `audit_retention_prune`).
    if (result.expired > 0 || result.garbage_collected > 0) {
      try {
        await deps.auditLog.logActivity({
          activity_id: '',
          timestamp: nowOf(),
          action: 'checkpoint_retention_prune',
          target: 'checkpoints',
          detail:
            `expired=${result.expired} garbage=${result.garbage_collected} `
              + `deferred=${result.deferred} failed=${result.failed} `
              + `inspected=${result.inspected}`,
        });
      } catch {
        // best-effort — the prune itself already happened.
      }
    }

    return result;
  };

  return {
    async run() {
      if (inflight) return inflight;
      inflight = runOnce().finally(() => {
        inflight = null;
      });
      return inflight;
    },

    async runSafe() {
      try {
        return await this.run();
      } catch (err) {
        try {
          await deps.auditLog.logActivity({
            activity_id: '',
            timestamp: nowOf(),
            action: 'checkpoint_retention_prune',
            target: 'checkpoints',
            detail: `error: ${err instanceof Error ? err.message : String(err)}`,
          });
        } catch { /* best-effort */ }
        return null;
      }
    },
  };
};
