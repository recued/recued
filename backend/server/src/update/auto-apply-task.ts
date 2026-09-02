/** D-178 P1 — the periodic release task (check always; apply when permitted).
 *
 *  The fourth-execution-mode (idle-driven, server-side) half of the update
 *  story. Two jobs, split by the effective `update.mode`:
 *
 *    - **`notify`** (and `auto` on a channel that cannot self-apply) — run the
 *      CHECK: fetch + verify the signed manifest, resolve it LOCALLY, advance
 *      the anti-replay floor, and record an available release ONCE per version.
 *      This is what makes `notify` mode mean something on a headless server: it
 *      is the mode named for a notification, and without a scheduled check the
 *      only checkers were the owner-driven rpc and the Updates card's poll —
 *      i.e. nothing at all unless a browser happened to be open.
 *    - **`auto`** on a self-applying channel (binary / docker-thin) — resolve
 *      the apply target and, for an auto-apply-eligible release (in the rollout
 *      cohort, not a major, I-4/I-7), drive `runApply` with `trigger: 'auto'`.
 *      The orchestrator's `isQuiesced` port (wired to the real engine-busy
 *      signal at boot) is the final gate; on success it stages the binary +
 *      requests the supervisor restart, so a successful step ends the process.
 *    - **`off`** — no network, ever. The mode has to be real for the check to
 *      be honest about being disableable (I-1).
 *
 *  ⚠ The apply half is OPTIONAL by construction: `docker-baked` and `source`
 *  have no self-apply path, so `buildApplyOrchestratorDeps` returns undefined
 *  for them. Before this slice the whole task was gated on those deps, so the
 *  two channels that DEFAULT to `notify` were the two that never ran a
 *  scheduled check at all.
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

import type { ReleaseCheckResponse } from '@recued/contracts';
import type { NotificationMessage } from '@recued/notification';

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

/** ⚠ The VALUE is a persisted housekeeping cursor key — renaming it orphans
 *  every installed server's schedule (they would all re-check immediately, in
 *  step, which is exactly what the jitter exists to prevent). The task grew a
 *  check half in a later slice; the id keeps the original spelling on purpose. */
export const UPDATE_AUTO_APPLY_TASK_ID = 'update-auto-apply';

/** Per-channel base check interval (ms) before jitter. Stable resolves daily,
 *  edge every 6h — mirrors the spec's check cadence. */
const STABLE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const EDGE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** ±25% jitter band so fleet manifest fetches spread out (I-1: no identifier on
 *  the wire, so the only de-correlation is local timing). */
const JITTER_SPREAD = 0.25;

/** The self-apply half — absent on the delegated channels (`docker-baked` /
 *  `source`), where checking is the whole job. */
export interface UpdateApplyCapability {
  /** The apply orchestrator ports (ledger / download / verify / swap / restart /
   *  the real `isQuiesced`). Shared with the manual `update.apply` rpc. */
  ports: ApplyOrchestratorPorts;
  /** Fetch + verify + resolve the apply target (artifact-bearing twin of the
   *  check). */
  resolveForApply: () => Promise<ResolveForApplyResult>;
}

export interface UpdateAutoApplyTaskDeps {
  /** Fetch + verify + resolve the CHECK projection (`runReleaseCheck`). Present
   *  on every supported platform — the check is channel-independent by design
   *  (D-178 I-1: identifier-free static GET, resolved locally), which is why it
   *  can run where apply cannot. */
  runCheck: () => Promise<ReleaseCheckResponse>;
  /** Self-apply capability, when the channel has one. Absent → the task checks
   *  and records, and never applies whatever the mode says. */
  apply?: UpdateApplyCapability;
  /** Apply-policy: the persisted user override + build-stamped channel + the raw
   *  `RECUED_SELF_UPDATE` value (env wins). Resolved to an effective mode each
   *  step so a mid-run `update.set_mode` takes effect on the next cycle. */
  modeStore: UpdateModeStore;
  channel: DistributionChannel;
  envMode?: string;
  /** The last available version already reported to the owner, and the setter
   *  that records a fresh one. Backed by the same `release.check_state` row the
   *  rollout salt lives in. Absent → every `update-available` cycle reports
   *  (used by tests; production always wires it). */
  readLastReported?: () => string | null;
  writeLastReported?: (version: string) => void;
  /** D-158 — push the available release to the owner's channels. Absent when no
   *  notification block exists on this boot (db-less harness), in which case the
   *  audit row is the whole report.
   *
   *  ⚠ The block's `notify` is best-effort and NEVER throws — a channel that
   *  fails to deliver is invisible here by contract. That is why the audit row
   *  is emitted independently rather than as a fallback: it is the durable
   *  trace, the notification is the reach. */
  notifyOwner?: (message: NotificationMessage) => Promise<void>;
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

/** Compose the D-158 message for an available release.
 *
 *  Pure, exported, and separately tested on purpose: this is the only part of
 *  the check the owner actually reads, and every fact it drops is a fact they
 *  do not have. Kept a function of the check response ALONE — it deliberately
 *  says nothing about HOW to apply, because that answer is channel-specific and
 *  already owned twice (the `recued update` CLI's `applyGuidance`, and the
 *  Settings → Updates card). A third copy is how the three drift apart.
 *
 *  ⚠ An out-of-cohort release IS reported. The staged rollout decides what
 *  auto-applies, not what the owner is allowed to know — withholding it would
 *  be the substrate making a judgment call that is the human's. It says so
 *  plainly instead. */
export const describeAvailable = (
  res: ReleaseCheckResponse,
  version: string,
): NotificationMessage => {
  const a = res.available;
  const lines = [`Recued ${version} is available (this server runs ${res.current_version}).`];
  if (a?.below_min_supported) {
    lines.push('Your version is below the minimum supported — updating is urgent.');
  }
  if (a?.is_major) {
    lines.push('This is a major release, so it is never applied automatically.');
  }
  if (a?.migration) {
    lines.push('It migrates the database on first boot. A snapshot is taken first, so it can be rolled back.');
  }
  if (a && !a.in_rollout_cohort) {
    lines.push('The staged rollout has not reached this server yet. You can still apply it yourself.');
  }
  if (res.docker) {
    lines.push(
      res.docker.artifact === 'docker-baked'
        ? `Recreate this server with the signed image: ${res.docker.pull_ref}`
        : `Recovery image (signed manifest digest): ${res.docker.pull_ref}`,
    );
  }
  return {
    title: a?.below_min_supported ? 'Update urgently available' : 'Update available',
    text: lines.join(' '),
    ...(a?.notes_url ? { link_url: a.notes_url } : {}),
  };
};

/** Launcher policy is itself an owner intervention. In particular, docker-thin
 * defaults to auto mode, so suppressing this result leaves a headless install
 * permanently stuck while every scheduled cycle appears successful. */
export const describeLauncherOutdated = (res: ReleaseCheckResponse): NotificationMessage => {
  const lines = ['This server cannot apply the signed release until its update launcher is replaced.'];
  if (res.docker) {
    lines.push(
      `Recreate it with the signed ${res.docker.artifact} image: ${res.docker.pull_ref}`,
      `That image carries Recued ${res.docker.version}; this server runs ${res.current_version}.`,
    );
  }
  return {
    title: 'Update launcher required',
    text: lines.join(' '),
    ...(res.docker?.notes_url ? { link_url: res.docker.notes_url } : {}),
  };
};

/** A signed release can be globally available while omitting this host's
 * executable or paired native addon. Calling that merely "Update available"
 * sends the owner to an apply action that deterministically cannot work. */
export const describeArtifactUnavailable = (res: ReleaseCheckResponse): NotificationMessage => {
  const version = res.available?.version ?? 'unknown';
  const lines = [
    `Recued ${version} is available, but it has no complete binary and native-addon pair for this server.`,
  ];
  if (res.docker) {
    lines.push(`Recreate it with the signed recovery image: ${res.docker.pull_ref}`);
  } else {
    lines.push('Keep the current version running and report the missing platform artifact.');
  }
  return {
    title: 'Update unavailable for this platform',
    text: lines.join(' '),
    ...(res.available?.notes_url ? { link_url: res.available.notes_url } : {}),
  };
};

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

  /** Report an outcome that needs owner action. This accepts the projection
   * carried by resolveForApply, so auto mode neither performs a second fetch
   * nor silently loses a no-artifact / major / cohort / launcher refusal. */
  const reportOutcome = async (
    ctx: HousekeepingContext,
    res: ReleaseCheckResponse,
    reason: 'available' | 'no-artifact' | 'launcher-outdated' =
      res.status === 'launcher-outdated' ? 'launcher-outdated' : 'available',
  ): Promise<void> => {
    const available = res.status === 'update-available' ? res.available : undefined;
    const launcher = reason === 'launcher-outdated' && res.status === 'launcher-outdated';
    const artifactUnavailable = reason === 'no-artifact' && available !== undefined;
    if (!available && !launcher) return;

    const reportKey = artifactUnavailable
      ? `artifact:${available.version}`
      : available
        ? available.version
        : `launcher:${res.docker?.version ?? res.current_version}:${res.docker?.digest ?? 'no-digest'}`;
    if (deps.readLastReported?.() === reportKey) return;

    let told = false;
    try {
      if (artifactUnavailable) {
        ctx.emitAuditRow({
          ts: ctx.now(),
          event_at: ctx.now(),
          action: 'update_artifact_unavailable',
          target: `${res.channel}:${available.version}`,
          run_mode: 'live',
          detail: {
            from_version: res.current_version,
            to_version: available.version,
            channel: res.channel,
            reason: 'missing_binary_or_native_addon',
          },
        });
      } else if (available) {
        ctx.emitAuditRow({
          ts: ctx.now(),
          event_at: ctx.now(),
          action: 'update_available',
          target: `${res.channel}:${available.version}`,
          run_mode: 'live',
          detail: {
            from_version: res.current_version,
            to_version: available.version,
            channel: res.channel,
            migration: available.migration,
            is_major: available.is_major,
            below_min_supported: available.below_min_supported,
            in_rollout_cohort: available.in_rollout_cohort,
          },
        });
      } else {
        ctx.emitAuditRow({
          ts: ctx.now(),
          event_at: ctx.now(),
          action: 'update_launcher_outdated',
          target: res.docker?.release_identity ?? `${res.channel}:launcher`,
          run_mode: 'live',
          detail: {
            from_version: res.current_version,
            to_version: res.docker?.version,
            channel: res.channel,
            artifact: res.docker?.artifact,
            pull_ref: res.docker?.pull_ref,
          },
        });
      }
      told = true;
    } catch {
      /* best-effort — the notify below may still carry it */
    }

    if (deps.notifyOwner) {
      try {
        await deps.notifyOwner(
          artifactUnavailable
            ? describeArtifactUnavailable(res)
            : available
              ? describeAvailable(res, available.version)
              : describeLauncherOutdated(res),
        );
        told = true;
      } catch {
        /* a transport failure must not stop the housekeeping cycle */
      }
    }

    // LAST: this key means at least one owner-visible path accepted the report.
    if (told) {
      try {
        deps.writeLastReported?.(reportKey);
      } catch {
        /* best-effort */
      }
    }
  };

  /** The check-only cycle: fetch + verify + resolve, and record an available
   *  release ONCE per version.
   *
   *  The de-dup is why `last_reported_version` exists. Without it a server
   *  sitting on a pending release re-announces it every cadence forever, which
   *  trains the owner to switch the mode `off` — and an owner on `off` is a
   *  server that never checks, which is the state this task was built to end. */
  const runCheckCycle = async (
    ctx: HousekeepingContext,
    reschedule: (base: number) => AutoApplyCursor,
  ): Promise<HousekeepingStepResult> => {
    let res: ReleaseCheckResponse;
    try {
      res = await deps.runCheck();
    } catch {
      // Same posture as the apply resolver's throw: a transient fetch/verify
      // failure is silent-retry on the daily base, never a hammered endpoint.
      return { status: 'complete', cursor: reschedule(PRE_RESOLVE_INTERVAL_MS) };
    }

    const interval = res.channel === 'edge' ? EDGE_CHECK_INTERVAL_MS : STABLE_CHECK_INTERVAL_MS;

    await reportOutcome(ctx, res);
    return { status: 'complete', cursor: reschedule(interval) };
  };

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

    // `off` — the ONE branch that must never touch the network. The check's
    // "and it is disableable" claim (I-1) is only true because this returns
    // before any fetch; nothing downstream re-checks it.
    if (mode.mode === 'off') {
      return { status: 'complete', cursor: reschedule(PRE_RESOLVE_INTERVAL_MS) };
    }

    // `notify`, or `auto` on a channel with no self-apply path (docker-baked /
    // source, or a delegated channel with RECUED_SELF_UPDATE=auto forced on it):
    // CHECK ONLY. One fetch, same cadence, no apply.
    const apply = deps.apply;
    if (mode.mode !== 'auto' || !apply) {
      return await runCheckCycle(ctx, reschedule);
    }

    let resolved: ResolveForApplyResult;
    try {
      resolved = await apply.resolveForApply();
    } catch (err) {
      // A transient fetch/verify throw is silent-retry (fail open on checking).
      // Reschedule on the daily base so a flaky feed doesn't hammer the endpoint.
      void err;
      return { status: 'complete', cursor: reschedule(PRE_RESOLVE_INTERVAL_MS) };
    }

    const channelInterval = resolved.report.channel === 'edge'
      ? EDGE_CHECK_INTERVAL_MS
      : STABLE_CHECK_INTERVAL_MS;

    if (resolved.status !== 'applyable') {
      // Most outcomes are quiet. A signed available release with no applicable
      // pair and a launcher-outdated recovery target are owner interventions;
      // reportOutcome selects those from the same resolve.
      const reportReason = resolved.status === 'no-artifact'
        ? 'no-artifact'
        : resolved.status === 'launcher-outdated'
          ? 'launcher-outdated'
          : 'available';
      await reportOutcome(ctx, resolved.report, reportReason);
      return { status: 'complete', cursor: reschedule(channelInterval) };
    }

    // I-4 / I-7 — only the in-cohort, non-major release auto-applies. A major or
    // an out-of-rollout release is notify-only (the check rpc / update card
    // surfaces it; the owner applies it explicitly via `update.apply`).
    if (!resolved.autoApplyEligible) {
      await reportOutcome(ctx, resolved.report);
      return { status: 'complete', cursor: reschedule(channelInterval) };
    }

    const result = await runApply(apply.ports, {
      releaseIdentity: resolved.releaseIdentity,
      fromVersion: resolved.fromVersion,
      toVersion: resolved.toVersion,
      channel: resolved.channel,
      migration: resolved.migration,
      artifact: resolved.artifact,
      libArtifact: resolved.libArtifact,
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
        'Check for a signed release on a jittered cadence (unless update mode is off), and auto-apply an eligible one when the engine is idle and the mode + channel allow it.',
      interruptible: false,
      kind: 'core',
      tags: ['kind:core', 'domain:update', 'surface:deterministic'],
    },
    step,
  };
};
