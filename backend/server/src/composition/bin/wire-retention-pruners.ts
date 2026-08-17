/** Phase B + D-145 PB12 + D-145 PB14 + D-157 N.8 — retention pruner
 *  registrations.
 *
 *  Best-effort periodic pruners that the background-services registry owns
 *  once `cmdServe` calls this helper. The original four are documented below;
 *  later privacy stores register beside them through the same lifecycle:
 *    - `audit-prune` (Phase B) — age + size reclaim for the audit gate.
 *      Cadence configurable via `audit.prune_interval_s` (floored at
 *      60s, defaults 1h). Skipped when `auditRetention` is absent
 *      (db-less harness).
 *    - `s2s-preview-prune` (D-145 PB12 / Codex P2 fold 2026-05-10) —
 *      drops expired s2s preview-token rows. Fixed 1h cadence; the
 *      consume path already filters by expiry, so this is purely the
 *      privacy-contract delete-on-disk pass. Skipped when
 *      `s2sPreviewStore` is absent.
 *    - `correction-events-prune` (D-145 PB14) — drops correction-event
 *      rows older than the per-kind retention window. Fixed daily
 *      cadence — corrections accrue slowly. Skipped when
 *      `correctionEventsStore` is absent.
 *    - `checkpoint-stale-prune` (D-157 N.8) — the staleness guard for
 *      paused preflight approvals (`preflight.stale_after_days`, read
 *      live each pass; 0 disables) + garbage collection of orphaned /
 *      terminal / superseded checkpoint rows. Fixed 1h cadence — the
 *      checkpoint store holds a handful of rows, and the window is
 *      days-scale; the hourly tick mostly exists so a crash-residue
 *      row (which can carry `pii_ledgers`) is reclaimed promptly once
 *      past its grace. Skipped when `checkpointStore` / `auditLog` is
 *      absent.
 *
 *  Every pruner is best-effort: per-tick failures must not crash the
 *  server. The audit + checkpoint pruners have their own `runSafe()`
 *  wrappers; the other two get inline try/catch (mirroring
 *  pre-extraction shape).
 *
 *  `fireImmediate: true` on every registration so a restart sweeps
 *  immediately rather than waiting a full interval. The
 *  background-services registry handles `.unref()` + final
 *  `clearInterval` flow. */

import type { BackgroundServiceRegistry } from './wire-background-services.js';
import type { AuditRetention } from '../../audit-retention.js';
import {
  EXECUTION_CASE_ARGUMENT_RETENTION_MS,
  type ExecutionCaseArgumentStore,
} from '../../storage/execution-case-argument-store.js';
import {
  EXECUTION_CASE_SOURCE_RETENTION_MS,
} from '../../execution-case-core.js';
import type {
  ExecutionCaseCompiler,
} from '../../execution-case-compiler.js';
import { createCheckpointRetention } from '../../checkpoint-retention.js';
import type { RuntimeConfigStore } from '@recued/config';
import { HANDLED_ASK_RETENTION_MS, type NotificationBlock } from '@recued/notification';
import type { AuditLogStore, CheckpointStore } from '@recued/storage';
import type { S2SPreviewStore } from '../../s2s-preview/store.js';
import type { CorrectionEventsStore } from '../../storage/correction-events-store.js';
import type {
  ExecutionCaseLifecycle,
} from '../../chat-execution-case-tools.js';
import {
  sweepMcpRecipeCallbackRetention,
} from '../../mcp-recipe-callback.js';
import type { SharedStore } from '../../storage/shared-store.js';
import type { ChatInboundTokenStore } from '../../storage/chat-inbound-token-store.js';
import type {
  ReceptionManageCredentialStore,
} from '../../storage/reception-manage-credential-store.js';
import {
  runReceptionLookupExpirySweep,
  type ReceptionLookupExpirySweepDeps,
} from '../../reception-lookup-expiry-sweep.js';

export interface ComposeRetentionPrunersDeps {
  readonly backgroundServices: BackgroundServiceRegistry;
  readonly runtimeConfig: RuntimeConfigStore;
  readonly auditRetention: AuditRetention | undefined;
  readonly s2sPreviewStore: S2SPreviewStore | undefined;
  readonly correctionEventsStore: CorrectionEventsStore | undefined;
  /** Recipe-callback TTL and terminal-token payload scrub. Both stores are
   * required; independent absence skips only this pruner. */
  readonly mcpRecipeCallbackStore?:
    | Pick<SharedStore, 'list' | 'read' | 'compareAndSet'>
    | undefined;
  readonly mcpRecipeCallbackTokenStore?:
    | Pick<ChatInboundTokenStore, 'getTokenById' | 'drainAuthorityChanges'>
    | undefined;
  /** D-219 — the capture-only tool-argument buffer. ⛔ Nothing READS it, which
   *  is exactly why it needs a pruner: an unread store of raw arguments with no
   *  age bound is an archive nobody decided to keep. Absent ⇒ no sweep (db-less
   *  harness), same posture as every other store here. */
  readonly executionCaseArgumentStore?:
    | Pick<ExecutionCaseArgumentStore, 'pruneOlderThan'>
    | undefined;
  /** D-219 — retention for the source corpus slice 9a made grow on ~87% of
   *  turns. Narrowed to the one method: this registration must not be able to
   *  compile, rebuild, or delete a root. Absent ⇒ no sweep (db-less harness). */
  readonly executionCaseSourcePruner?:
    | Pick<ExecutionCaseCompiler, 'pruneSourcesOlderThan'>
    | undefined;
  /** D-157 N.8 — the checkpoint sweep's stores. Both required for the
   *  registration (the sweep classifies rows against their run
   *  anchors); absent on the db-less harness. */
  readonly checkpointStore?: CheckpointStore | undefined;
  readonly auditLog?: AuditLogStore | undefined;
  /** D-214 closure observer for D-157 approval expiries. */
  readonly executionCaseLifecycle?: ExecutionCaseLifecycle | undefined;
  /** D-240 slice 4 — the reception credential store, for TWO passes:
   *
   *  1. ⛔⛔ ITS `purge` HAD NO CALLER AT ALL. D-210 Appendix B shipped the
   *     method and never registered it, so `reception_manage_credentials` has
   *     been append-only since — and D-240 slice 2's `ceiling_at` backstop,
   *     which I described as closing the deferred-credential leak, was resting
   *     on a collector that never ran. Wiring it here is the repair.
   *  2. The `until_resolved` stamp sweep.
   *
   *  Absent ⇒ neither runs (db-less harness), same posture as every store here. */
  readonly receptionCredentialStore?:
    | ReceptionManageCredentialStore
    | undefined;
  /** D-240 slice 4 — forward lookup from a deferred credential's record to its
   *  durable target's completion. Absent ⇒ the stamp sweep is skipped and
   *  deferred credentials live to their ceiling, which is the documented
   *  fail-safe rather than a leak. */
  readonly receptionRecordCompletion?:
    | ReceptionLookupExpirySweepDeps['readCompletion']
    | undefined;
  /** D-157 N.8 — the notification block's ask-state reads (the
   *  never-drop-a-decision check + the race-safe prompt close).
   *  Narrowed to exactly the two methods the sweep consumes. Absent ⇒
   *  the block was never constructed this process, so no inbound
   *  answer path exists and the sweep expires without prompt
   *  bookkeeping. */
  readonly notificationBlock?:
    | Pick<NotificationBlock, 'getAsk' | 'cancelAsk' | 'pruneHandledAsks'>
    | undefined;
  /** Time source for `pruneExpired` / `pruneOlderThan`. Defaults to
   *  `Date.now`. Test seam. */
  readonly now?: () => number;
}

const HOUR_MS = 3_600_000;
const MIN_AUDIT_INTERVAL_MS = 60_000;
const DAY_MS = 24 * HOUR_MS;

/** Default staleness window when the runtime-config read fails (the
 *  schema default for `preflight.stale_after_days`). */
const DEFAULT_STALE_AFTER_DAYS = 30;

/** Register the retention pruner intervals with `backgroundServices`.
 *  Each registration is gated independently — a missing store skips
 *  that pruner but doesn't block the others. */
export const composeRetentionPruners = (
  deps: ComposeRetentionPrunersDeps,
): void => {
  const nowOf = deps.now ?? Date.now;

  // Phase B audit retention cron. Defaults to hourly; reads the live
  // config value at registration time. Registered with the background-
  // services registry — `.unref()` + final `clearInterval` flow through
  // the shared helper.
  if (deps.auditRetention) {
    const retention = deps.auditRetention;
    const intervalMs = (() => {
      try {
        const seconds = deps.runtimeConfig.get('audit.prune_interval_s') as number;
        return Math.max(MIN_AUDIT_INTERVAL_MS, seconds * 1000);
      } catch {
        return HOUR_MS;
      }
    })();
    deps.backgroundServices.registerInterval({
      name: 'audit-prune',
      intervalMs,
      tick: async () => {
        try {
          await retention.runSafe();
        } catch {
          // `runSafe` is expected to contain its own errors; retain the
          // pruner's best-effort contract if an implementation regresses.
        }
      },
      fireImmediate: true,
    });
  }

  // D-145 PB12 Codex P2 fold (2026-05-10) — periodic pruner for the
  // s2s_preview_tokens table. Without this, expired packets persist
  // indefinitely on disk past their TTL — the consume path filters by
  // expiry but the bytes stay until the next compaction. The privacy
  // contract (substrate-level expiry) needs the on-disk row gone, not
  // just unreadable. Cadence matches the audit pruner default (1 hour)
  // since the s2s_preview store sees lower volume than the audit log;
  // the TTL clamp window starts at 1 minute so a 1-hour pruner cycle
  // gives an upper-bound persistence-past-TTL window of ≈ TTL + 1h.
  if (deps.s2sPreviewStore) {
    const store = deps.s2sPreviewStore;
    deps.backgroundServices.registerInterval({
      name: 's2s-preview-prune',
      intervalMs: HOUR_MS,
      tick: () => {
        try {
          store.pruneExpired(nowOf());
        } catch {
          // Best-effort — a prune failure must not crash the server.
        }
      },
      fireImmediate: true,
    });
  }

  // D-240 slice 4 — the reception credential passes.
  //
  // ⚠ ONE registration, TWO passes, in this order on purpose: STAMP first, then
  // PURGE. A credential whose record just resolved should have its shortened
  // expiry applied before the collector looks, so it can be reclaimed in the
  // same tick rather than waiting a full interval. Reversing them costs an hour
  // of retention on every resolved request, for nothing.
  if (deps.receptionCredentialStore) {
    const credentialStore = deps.receptionCredentialStore;
    const readCompletion = deps.receptionRecordCompletion;
    deps.backgroundServices.registerInterval({
      name: 'reception-credential-retention',
      intervalMs: HOUR_MS,
      tick: () => {
        try {
          // The stamp pass is skipped when no completion reader is wired —
          // deferred credentials then live to their ceiling, which is the
          // documented fail-safe rather than a leak.
          if (readCompletion !== undefined) {
            runReceptionLookupExpirySweep({ credentialStore, readCompletion, now: nowOf });
          }
          credentialStore.purge(nowOf());
        } catch {
          // Best-effort — a retention failure must not crash the server.
        }
      },
      fireImmediate: true,
    });
  }

  // Recipe callbacks carry only bounded pointers, but logical non-delivery is
  // not a retention policy. Scrub expired rows and rows whose token is now
  // missing, revoked, expired, rebound, or ungranted. Keep the CAS row as a
  // minimal revision fence so a concurrent enqueue cannot suffer delete/reuse
  // ABA; a future event on the same route advances and replaces that fence.
  if (deps.mcpRecipeCallbackStore && deps.mcpRecipeCallbackTokenStore) {
    const store = deps.mcpRecipeCallbackStore;
    const inboundTokenStore = deps.mcpRecipeCallbackTokenStore;
    deps.backgroundServices.registerInterval({
      name: 'mcp-recipe-callback-prune',
      intervalMs: HOUR_MS,
      tick: async () => {
        try {
          await sweepMcpRecipeCallbackRetention({
            store,
            inboundTokenStore,
            now: nowOf,
          });
        } catch {
          // Best-effort; inactive callbacks remain authorization-inert and the
          // next immediate/hourly pass retries their payload scrub.
        }
      },
      fireImmediate: true,
    });
    deps.backgroundServices.register({
      name: 'mcp-recipe-callback-authority-drain',
      kind: 'emitter',
      stop: () => inboundTokenStore.drainAuthorityChanges(),
    });
  }

  // D-145 PB14 — periodic pruner for the correction_events table.
  // Removes rows older than CORRECTION_EVENT_RETENTION_MS (1 year)
  // except kinds in CORRECTION_EVENT_DURABLE_KINDS (contact_merged +
  // standing_instruction_added). Cadence is daily — corrections accrue
  // slowly and a 1-year retention window doesn't need tight sweeps.
  // Best-effort: pruner failures must not crash the server (mirrors
  // the audit + s2s_preview pruners).
  if (deps.correctionEventsStore) {
    const store = deps.correctionEventsStore;
    deps.backgroundServices.registerInterval({
      name: 'correction-events-prune',
      intervalMs: DAY_MS,
      tick: () => {
        try {
          store.pruneOlderThan(nowOf());
        } catch {
          // Best-effort — a prune failure must not crash the server.
        }
      },
      fireImmediate: true,
    });
  }

  // D-219 — the capture-only argument buffer's age sweep. Daily, like the
  // correction-events pruner: the window is 90 days and does not need tight
  // passes. ⚠ This window IS the horizon a future argument-consuming slice can
  // backfill from — shortening it shortens what that decision can ever see.
  if (deps.executionCaseArgumentStore) {
    const store = deps.executionCaseArgumentStore;
    deps.backgroundServices.registerInterval({
      name: 'execution-case-arguments-prune',
      intervalMs: DAY_MS,
      tick: () => {
        try {
          store.pruneOlderThan(
            nowOf() - EXECUTION_CASE_ARGUMENT_RETENTION_MS,
          );
        } catch {
          // Best-effort — a prune failure must not crash the server.
        }
      },
      fireImmediate: true,
    });
  }

  // D-219 — the execution-case SOURCE sweep: reports + observations that are
  // older than the window AND back no materialized case. Daily, and the last of
  // the pruners deliberately — it ends in a full corpus rebuild when it deletes
  // anything, so it should run against an already-swept database.
  //
  // ⛔ It never touches a report a case rests on; see `pruneSourcesOlderThan`.
  // Retention that eats what it is retaining is amnesia, not retention.
  if (deps.executionCaseSourcePruner) {
    const pruner = deps.executionCaseSourcePruner;
    deps.backgroundServices.registerInterval({
      name: 'execution-case-sources-prune',
      intervalMs: DAY_MS,
      tick: async () => {
        try {
          await pruner.pruneSourcesOlderThan(
            nowOf() - EXECUTION_CASE_SOURCE_RETENTION_MS,
          );
        } catch {
          // Best-effort — a prune failure must not crash the server.
        }
      },
      fireImmediate: true,
    });
  }

  // D-157 N.8 — the stale-checkpoint retention sweep. Window read live
  // each pass so a Settings change takes effect without restart; the
  // wire `0` collapses to `null` (guard off — garbage collection still
  // runs, mirroring how audit retention's age pass disables while its
  // size pass keeps protecting the quota).
  if (deps.checkpointStore && deps.auditLog) {
    const block = deps.notificationBlock;
    const retention = createCheckpointRetention({
      checkpointStore: deps.checkpointStore,
      auditLog: deps.auditLog,
      ...(block !== undefined
        ? {
            askHooks: {
              getAsk: (ask_id) => block.getAsk(ask_id),
              cancelAsk: (ask_id) => block.cancelAsk(ask_id),
            },
          }
        : {}),
      now: nowOf,
      ...(deps.executionCaseLifecycle
        ? {
            onExpired: async (entry) => {
              const source = entry.execution_source;
              if (
                source?.channel !== 'chat'
                || typeof source.chat_session_id !== 'string'
                || typeof source.turn_id !== 'string'
              ) return;
              await deps.executionCaseLifecycle?.finalizeTurn({
                session_id: source.chat_session_id,
                turn_id: source.turn_id,
              });
            },
          }
        : {}),
      config: () => {
        let days: number;
        try {
          days = deps.runtimeConfig.get('preflight.stale_after_days') as number;
        } catch {
          days = DEFAULT_STALE_AFTER_DAYS;
        }
        return { staleAfterDays: days === 0 ? null : days };
      },
    });
    deps.backgroundServices.registerInterval({
      name: 'checkpoint-stale-prune',
      intervalMs: HOUR_MS,
      tick: async () => {
        try {
          await retention.runSafe();
        } catch {
          // Best-effort retention must not reject the timer lifecycle.
        }
      },
      fireImmediate: true,
    });
  }

  // D-210 — the terminal-ask retention sweep. `ask-store.ts` has claimed
  // since D-158 P3 that the store is "small + bounded" and prunes terminal
  // rows on a retention window; there was no such prune and `handled` rows
  // accumulated forever.
  //
  // ⛔ SEQUENCED AFTER the answer-audit row, not before it. Until the block
  // wrote `approval_allow` / `approval_deny`, the ask row was the ONLY
  // record of what the owner was shown, which option they picked, which
  // channel they answered on, and when — no audit row referenced a
  // terminal ask at all. Pruning first would have destroyed that silently.
  // The two land together in this slice for exactly that reason.
  if (deps.notificationBlock) {
    const block = deps.notificationBlock;
    deps.backgroundServices.registerInterval({
      name: 'handled-ask-prune',
      intervalMs: HOUR_MS,
      tick: async () => {
        try {
          await block.pruneHandledAsks(nowOf() - HANDLED_ASK_RETENTION_MS);
        } catch {
          // Best-effort — a prune failure must not crash the server
          // (mirrors the sweeps above).
        }
      },
      fireImmediate: true,
    });
  }
};
