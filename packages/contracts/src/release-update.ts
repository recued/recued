/** D-178 — Release & Update Substrate, the rpc-facing check projection.
 *
 *  `update.check` (owner-only, reserved out of MCP via `update.` in
 *  `MCP_RESERVED_RPC_PREFIXES`) fetches the signed release manifest, verifies
 *  its detached minisign signature (I-2), and resolves it against this install
 *  LOCALLY (anti-replay / freshness / channel / rollout — I-1/I-7/I-10). This
 *  module is the wire shape only; the resolution engine lives in
 *  `@recued/release` (`resolveRelease`) and the server orchestrator in
 *  `backend/server`. The apply/rollback verbs land in later slices.
 */

/** What the check resolved to. Mirrors `@recued/release`'s `ReleaseResolution`
 *  status plus the transport-level outcomes the server adds (the manifest could
 *  not be fetched, or its signature did not verify) and the not-configured case
 *  (no trusted release key wired yet — pre-GA / db-less harness). */
export type ReleaseCheckStatus =
  | 'update-available'
  | 'up-to-date'
  | 'stale-feed'
  | 'launcher-outdated'
  | 'replay'
  | 'fetch-failed'
  | 'bad-signature'
  | 'not-configured';

export interface ReleaseCheckResponse {
  status: ReleaseCheckStatus;
  /** The running version + channel, echoed for the UI card. */
  current_version: string;
  channel: 'stable' | 'edge';
  /** Present iff `status === 'update-available'`. */
  available?: {
    version: string;
    /** Release migrates the SQLite schema on boot (rollback-rule input). */
    migration: boolean;
    /** Major bump — notify-only, never auto-applied (I-4). */
    is_major: boolean;
    /** Running version is below the release's `min_supported` — URGENT. */
    below_min_supported: boolean;
    /** Local staged-rollout cohort membership (no identifier left the box). */
    in_rollout_cohort: boolean;
    /** Safe to auto-apply (in cohort AND not a major). */
    auto_apply_eligible: boolean;
    notes_url: string;
  };
  /** Manifest publish counter that produced this result (anti-replay audit). */
  sequence?: number;
  /** Freshness horizon, present on `stale-feed`. */
  expires_at?: string;
  /** A short, non-secret diagnostic for `fetch-failed` / `bad-signature`. */
  detail?: string;
}

/** Per-install apply policy (spec § Update machinery, "Apply, per channel").
 *  `auto` self-applies eligible releases from quiesce; `notify` raises the
 *  update card without applying; `off` disables even the check. Default is
 *  channel-derived — `auto` ONLY on `docker-thin`, `notify` everywhere else
 *  including `binary`, because an apply runs migrations against the owner's own
 *  warehouse and a default nobody was shown is not consent;
 *  `RECUED_SELF_UPDATE` wins inside containers. */
export type UpdateMode = 'auto' | 'notify' | 'off';

export interface UpdateModeStatus {
  /** The effective mode after env / user-override / channel-default resolution. */
  mode: UpdateMode;
  /** Where the effective mode came from. */
  source: 'env' | 'user' | 'default';
  /** `RECUED_SELF_UPDATE` is set — the user-facing toggle is locked to env. */
  env_locked: boolean;
  /** The channel-derived default (shown when the user clears their override). */
  channel_default: UpdateMode;
}

/** `update.apply` outcome (owner-only). `restarting` is the success path — the
 *  verified artifact is staged + the supervisor was asked to restart into it
 *  (the commit happens on the next healthy boot). Everything else is a
 *  before-restart refusal that left the install untouched (the in-flight lock
 *  is released on every failed apply, never wedged). `not-available` folds the
 *  resolve outcomes that aren't an installable artifact (up-to-date / stale /
 *  replay / launcher-outdated / no platform binary); `not-applicable` is the
 *  delegated-channel case (docker / source — the host updates the image).
 *  `insufficient-storage` is the up-front disk guard — the data volume can't fit
 *  the artifact download + the pre-migration snapshot. */
export type UpdateApplyStatus =
  /** D-257 — accepted and RUNNING; the outcome arrives on `update.progress`.
   *
   *  ⛔ THE RPC USED TO AWAIT THE WHOLE APPLY, and the artifact is ~144 MB. The
   *  webclient's per-call timeout is 30s, so Settings → Updates rejected on every
   *  real update while the server went on to finish it — the owner was told it
   *  failed by the one surface that could see it succeed.
   *
   *  ⚠ A NEW CLIENT MAY STILL MEET AN OLD SERVER, which blocks and then answers
   *  with a terminal status. Both shapes have to be handled; this one is not a
   *  replacement for them. */
  | 'applying'
  | 'restarting'
  | 'deferred'
  | 'busy'
  | 'not-configured'
  | 'not-available'
  | 'not-applicable'
  | 'major-blocked'
  | 'insufficient-storage'
  | 'download-failed'
  | 'verify-failed'
  | 'stage-failed';

export interface UpdateApplyResponse {
  status: UpdateApplyStatus;
  /** Opaque server-ledger receipt, present only when the restart was accepted.
   * The webclient may persist/share this identifier to verify the exact
   * operation after reconnect; it contains no version, endpoint, or error. */
  operation_id?: string;
  /** The release the apply targeted, when one resolved (`<channel>:<version>`). */
  release_identity?: string;
  /** Target version, when a release resolved (UI confirmation copy). */
  to_version?: string;
  /** A short, non-secret diagnostic (deferred reason / failure detail). */
  detail?: string;
}

/** `update.rollback` outcome (owner-only). `rolled-back` swapped `recued.old`
 *  back (and restored the pre-migration snapshot when one applied) + asked the
 *  supervisor to restart; `refused` is the rollback guard (no previous binary /
 *  a migration with no snapshot); `busy` is the in-flight-apply lock (I-6). */
export type UpdateRollbackStatus = 'rolled-back' | 'refused' | 'busy' | 'not-configured' | 'not-applicable';

export interface UpdateRollbackResponse {
  status: UpdateRollbackStatus;
  /** Opaque server-ledger receipt, present only when the restart was accepted. */
  operation_id?: string;
  /** True when the rollback also restored a pre-migration SQLite snapshot. */
  restored_snapshot?: boolean;
  /** A short, non-secret diagnostic (refusal reason). */
  detail?: string;
}

/** Owner-only, read-only resolution of one accepted update/rollback receipt.
 * No version or ledger detail is exposed: the browser learns only whether the
 * exact operation awaits restart, completed, reverted, or has a durable
 * owner-reviewed unresolved closure. */
export type UpdateOperationStatusResponse =
  | { status: 'unknown' }
  | {
      status:
        | 'waiting_for_restart'
        | 'completed'
        | 'reverted'
        | 'closed_unresolved';
      operation: 'update' | 'rollback';
    };

/** Owner-reviewed, server-authoritative retirement of a receipt that the
 * selected server can no longer resolve. `closed_unresolved` is deliberately
 * not a success/failure claim: it proves only that the server durably recorded
 * the recovery closure while no release transition was in flight. A known
 * receipt races safely to its ordinary status instead. */
export type UpdateOperationClosureResponse =
  | UpdateOperationStatusResponse
  | {
      status: 'refused';
      reason: 'operation_in_flight' | 'not_supported';
    };
