/** D-178 P1 — the auto-apply-on-idle housekeeping task.
 *
 *  The fourth-execution-mode (idle-driven, server-side) half of the apply
 *  story: when the effective `update.mode` is `auto` and the channel
 *  self-applies (binary / docker-thin), this core housekeeping task fetches +
 *  verifies the signed manifest, resolves it LOCALLY against this install, and
 *  — for an auto-apply-eligible release (in the rollout cohort, not a major,
 *  I-4/I-7) — drives `runApply` with `trigger: 'auto'`. The apply orchestrator's
 *  `isQuiesced` port (wired to the real engine-busy signal at boot) is the final
 *  gate; on success the orchestrator stages the binary + requests the supervisor
 *  restart, so a successful step ends the process.
 *
 *  The owner-initiated `update.apply` rpc stays the manual path (`trigger:
 *  'manual'`, bypasses the quiesce wait); this task is the unattended one. Both
 *  walk the same I-2 verify boundary via `resolveForApply`.
 *
 *  Cadence (spec § Update machinery — "Check"): the task self-rate-limits to a
 *  per-channel base interval (stable ~daily, edge ~6h) with ±25% jitter so the
 *  fleet's manifest fetches de-correlate; between due times the step is a no-op
 *  `complete`. The housekeeping scheduler already only fires the cycle when the
 *  engine is idle, so a manifest fetch never competes with live runs.
 *
 *  Pre-GA (empty `TRUSTED_RELEASE_PUBKEY`) `resolveForApply` short-circuits to
 *  `not-configured` and the step no-ops — this task is wired ahead of the
 *  signing identity, inert until the key is pinned.
 *
 *  Spec: D-178 § Update machinery (Check + Apply + Quiesce). */

import type {
  HousekeepingCursor,
  HousekeepingStepResult,
} from '@recued/contracts';

import type {
  HousekeepingContext,
  HousekeepingTaskInstance,
} from '../housekeeping/registry.js';
import { runApply, type ApplyOrchestratorPorts } from './apply-orchestrator.js';
import type { ResolveForApplyResult } from './release-check.js';
import {
  resolveUpdateMode,
  type DistributionChannel,
  type UpdateModeStore,
} from './update-mode-store.js';

export const UPDATE_AUTO_APPLY_TASK_ID = 'update-auto-apply';

/** Per-channel base check interval (ms) before jitter. Stable resolves daily,
 *  edge every 6h — mirrors the spec's check cadence. */
const STABLE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const EDGE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** ±25% jitter band so fleet manifest fetches spread out (I-1: no identifier on
 *  the wire, so the only de-correlation is local timing). */
const JITTER_SPREAD = 0.25;

export interface UpdateAutoApplyTaskDeps {
  /** The apply orchestrator ports (ledger / download / verify / swap / restart /
   *  the real `isQuiesced`). Shared with the manual `update.apply` rpc. */
  ports: ApplyOrchestratorPorts;
  /** Fetch + verify + resolve the apply target (artifact-bearing twin of the
   *  check). */
  resolveForApply: () => Promise<ResolveForApplyResult>;
  /** Apply-policy: the persisted user override + build-stamped channel + the raw
   *  `RECUED_SELF_UPDATE` value (env wins). Resolved to an effective mode each
   *  step so a mid-run `update.set_mode` takes effect on the next cycle. */
  modeStore: UpdateModeStore;
  channel: DistributionChannel;
  envMode?: string;
  /** Inject randomness (tests pin it). Defaults to `Math.random`. */
  random?: () => number;
}

interface AutoApplyCursor {
  kind: 'time';
  /** The next-due wall-clock time. Persisted so the jittered schedule survives
   *  probe ticks (the cursor's `last_seen_at` slot carries next-due here, not a
   *  last-seen marker — the task is stateless beyond its schedule). */
  last_seen_at: number;
}

const isAutoApplyCursor = (cursor: HousekeepingCursor): cursor is AutoApplyCursor =>
  cursor.kind === 'time';

/** Pre-resolve daily floor. The stable/edge cadence split keys off the RELEASE
 *  channel (carried on the resolved artifact), not the distribution channel — so
 *  before a resolve (mode-off / fetch-throw) we fall back to the daily base. */
const PRE_RESOLVE_INTERVAL_MS = STABLE_CHECK_INTERVAL_MS;

/** Jittered next-due offset from `now` for a given base interval. */
const jitteredInterval = (base: number, random: () => number): number => {
  const factor = 1 - JITTER_SPREAD + random() * (2 * JITTER_SPREAD); // [0.75, 1.25]
  return Math.round(base * factor);
};

/** Build the `update-auto-apply` housekeeping task over the apply deps. */
export const createUpdateAutoApplyTask = (
  deps: UpdateAutoApplyTaskDeps,
): HousekeepingTaskInstance => {
  const random = deps.random ?? Math.random;

  const step = async (
    ctx: HousekeepingContext,
    cursor: HousekeepingCursor,
    _budget_ms: number,
  ): Promise<HousekeepingStepResult> => {
    const now = ctx.now();

    // Cadence gate — not due yet → cheap no-op (no network).
    if (isAutoApplyCursor(cursor) && now < cursor.last_seen_at) {
      return { status: 'complete', cursor };
    }

    // Effective mode: only `auto` enrolls in unattended apply. `notify`/`off`
    // leave the update card to surface the available release; never self-apply.
    const mode = resolveUpdateMode({
      channel: deps.channel,
      userMode: deps.modeStore.readUserMode(),
      ...(deps.envMode !== undefined ? { envMode: deps.envMode } : {}),
    });

    // Reschedule helper — the next due time, channel-aware once we know the
    // resolved release channel; falls back to the daily base otherwise.
    const reschedule = (base: number): AutoApplyCursor => ({
      kind: 'time',
      last_seen_at: now + jitteredInterval(base, random),
    });

    if (mode.mode !== 'auto') {
      return { status: 'complete', cursor: reschedule(PRE_RESOLVE_INTERVAL_MS) };
    }

    let resolved: ResolveForApplyResult;
    try {
      resolved = await deps.resolveForApply();
    } catch (err) {
      // A transient fetch/verify throw is silent-retry (fail open on checking).
      // Reschedule on the daily base so a flaky feed doesn't hammer the endpoint.
      void err;
      return { status: 'complete', cursor: reschedule(PRE_RESOLVE_INTERVAL_MS) };
    }

    const channelInterval =
      resolved.status === 'applyable' && resolved.channel === 'edge'
        ? EDGE_CHECK_INTERVAL_MS
        : STABLE_CHECK_INTERVAL_MS;

    if (resolved.status !== 'applyable') {
      // not-configured (pre-GA) / up-to-date / replay / stale-feed / no-artifact
      // / fetch / signature — nothing to auto-apply this cycle.
      return { status: 'complete', cursor: reschedule(channelInterval) };
    }

    // I-4 / I-7 — only the in-cohort, non-major release auto-applies. A major or
    // an out-of-rollout release is notify-only (the check rpc / update card
    // surfaces it; the owner applies it explicitly via `update.apply`).
    if (!resolved.autoApplyEligible) {
      return { status: 'complete', cursor: reschedule(channelInterval) };
    }

    const result = await runApply(deps.ports, {
      releaseIdentity: resolved.releaseIdentity,
      fromVersion: resolved.fromVersion,
      toVersion: resolved.toVersion,
      channel: resolved.channel,
      migration: resolved.migration,
      artifact: resolved.artifact,
      webclientArtifact: resolved.webclientArtifact,
      // Unattended — `runApply` consults `ports.isQuiesced` (the real engine-busy
      // signal) and DEFERS rather than restarting under load. On `restarting`
      // the orchestrator has staged the binary + requested the supervisor
      // restart, so the process is on its way down.
      trigger: 'auto',
    });

    // Best-effort audit trail of the auto-apply decision (the ledger already
    // records the apply lifecycle; this is the housekeeping-cycle attribution).
    try {
      ctx.emitAuditRow({
        ts: ctx.now(),
        event_at: ctx.now(),
        action: 'update_auto_apply_attempt',
        target: resolved.releaseIdentity,
        run_mode: 'live',
        detail: {
          to_version: resolved.toVersion,
          channel: resolved.channel,
          migration: resolved.migration,
          result: result.status,
          ...(result.status === 'deferred' ? { reason: result.reason } : {}),
        },
      });
    } catch {
      /* best-effort */
    }

    // `restarting` ends the process; `deferred`/`busy`/error statuses retry on
    // the next due cycle (a deferral re-checks quickly via the channel cadence —
    // we keep the schedule so we don't re-fetch every probe tick).
    return { status: 'complete', cursor: reschedule(channelInterval) };
  };

  return {
    meta: {
      id: UPDATE_AUTO_APPLY_TASK_ID,
      description:
        'Auto-apply an eligible signed release when the engine is idle and update mode is auto (binary / docker-thin channels).',
      interruptible: false,
      kind: 'core',
      tags: ['kind:core', 'domain:update', 'surface:deterministic'],
    },
    step,
  };
};
