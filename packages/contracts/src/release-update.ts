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
  /** ⛔ LEGACY — NO CURRENT SERVER EMITS THIS, AND CLIENTS MUST STILL ACCEPT IT.
   *  The freshness gate was removed on 2026-09-01 (see `resolve.ts`): a feed that
   *  has merely stopped moving is no longer a reason to refuse the newest release
   *  anyone has. But the webclient is ALWAYS-NEWEST against whatever server the
   *  owner installed, so a server predating that change still answers `stale-feed`
   *  and a client that dropped the member would fail to render its own update
   *  card. Kept on the wire, produced by nobody, and presented as "no update
   *  available" rather than as a state anybody has to understand. */
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
    /** The opaque `<channel>:<version>` token this release is known by, for a
     *  client to echo back as `UpdateApplyArgs.expected_release_identity`.
     *
     *  ⛔ ECHOED, NEVER REBUILT. A client could almost derive it from `channel` +
     *  `version` — and "almost" is the problem: the identity uses the INSTALL's
     *  channel, and an `edge` install legitimately resolves to a STABLE release
     *  (`resolveTarget` returns max(stable, edge)), so a client that assembled
     *  `stable:1.4.0` from what it was showing would mismatch `edge:1.4.0` and
     *  every bound apply on the edge channel would refuse itself. One derivation,
     *  server-side; the wire carries the token.
     *
     *  Optional: an older server omits it, the client then sends no binding, and
     *  the apply behaves exactly as it did before the field existed. */
    release_identity?: string;
    /** Release migrates the SQLite schema on boot (rollback-rule input). */
    migration: boolean;
    /** Major bump — notify-only, never auto-applied (I-4). */
    is_major: boolean;
    /** Running version is below the release's `min_supported` — URGENT. */
    below_min_supported: boolean;
    /** Local staged-rollout cohort membership (no identifier left the box). */
    in_rollout_cohort: boolean;
    /** The channel's staged-rollout percentage.
     *
     *  ⛔ THE WIRE CARRIED ONLY THE BOOLEAN, so no client could say what the spec
     *  requires it to say: "this release is in staged rollout (40%) — install
     *  anyway?". Without the number an out-of-cohort manual apply was a silent
     *  bypass — and with `rollout_pct` currently 0 on stable, EVERY manual apply
     *  is out of cohort. Optional so an older server that omits it degrades to the
     *  old, quieter behaviour rather than rendering "undefined%". */
    rollout_pct?: number;
    /** Safe to auto-apply (in cohort AND not a major). */
    auto_apply_eligible: boolean;
    notes_url: string;
  };
  /** Exact container pull target taken from the verified signed manifest.
   * Present only for docker-baked / docker-thin installations when the selected
   * release declares that channel. The digest is repeated separately for
   * structured consumers; `pull_ref` is the copy/paste-safe actuator and must
   * never be reconstructed from a mutable tag or release notes. It may also be
   * present with `launcher-outdated`, where recreating from this digest is the
   * recovery path. */
  docker?: {
    artifact: 'docker-baked' | 'docker-thin';
    version: string;
    release_identity: string;
    image: string;
    digest: string;
    pull_ref: string;
    notes_url: string;
  };
  /** Manifest publish counter that produced this result (anti-replay audit). */
  sequence?: number;
  /** ⛔ LEGACY, like the `stale-feed` status it accompanied — no current server
   *  populates it (D-260 withdrew the freshness gate). Kept so a response from
   *  an older server still parses. */
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
   *  replacement for them.
   *
   *  ⛔⛔ AND THE TERMINAL MAY REACH THE CLIENT BEFORE THIS ANSWER DOES. The
   *  handler starts the run and only then returns, so a refusal the apply reaches
   *  immediately — `busy`, `deferred`, `insufficient-storage` — resolves into the
   *  `update.progress` broadcast while this reply is still being dispatched
   *  (observed in-process as `["emit:busy", "rpc:applying"]`, and the wire only
   *  widens it). The two travel on DIFFERENT CHANNELS, so no ordering can be
   *  promised and none should be assumed: a client must let whichever ENDS the
   *  run win, rather than letting this status overwrite a terminal it has already
   *  handled. Doing the latter leaves the UI mid-flight over a run that has
   *  already declined. */
  | 'applying'
  | 'restarting'
  /** The feed moved between the release the caller REVIEWED and the one that
   *  resolved now, so the consent it is carrying does not belong to this
   *  release. Nothing was staged; the caller re-reads the card and decides
   *  again.
   *
   *  ⚠ A NEW UNION MEMBER NORMALLY REACHES CLIENTS THAT CANNOT NAME IT — that is
   *  why `runApply`'s supervisor refusal reuses `deferred` instead of adding one.
   *  This one is safe by construction and only this one: it can be returned ONLY
   *  in answer to `expected_release_identity`, a request field an older client
   *  never sends. A client that cannot name the status cannot ask the question
   *  that produces it. */
  | 'review-stale'
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

/** `update.apply` arguments (owner-only).
 *
 *  ⛔⛔ EVERY FIELD HERE IS CONSENT, AND CONSENT WITHOUT AN OBJECT IS NOT CONSENT.
 *  The call used to carry `force` alone: the client confirmed a MAJOR bump, or a
 *  staged-rollout bypass, against the release its card was showing — and then
 *  said nothing about WHICH release that was. The server re-fetches the feed and
 *  resolves again, so a publish between the two answers a "yes" the owner gave to
 *  a different version, `force` included. The window is short and the fix is one
 *  field; carrying an unbound "yes" is the part that was wrong.
 *
 *  ⚠ OPTIONAL, AND THEREFORE ONLY ENFORCED WHEN PRESENT. This is self-hosted:
 *  app.recued.com always serves the newest webclient while servers are whatever
 *  version their owner has, so BOTH skews are live. An older client sends
 *  neither field and must keep working exactly as before (absent = unbound, the
 *  old behaviour); a newer client talking to an older SERVER has its binding
 *  silently ignored, which is a degradation it cannot detect. Neither is a reason
 *  to make them required — a required field would break every paired client that
 *  predates this — but a client must not report the binding as enforced. */
export interface UpdateApplyArgs {
  /** Skip the notify-only gate on a MAJOR bump (I-4).
   *
   *  ⛔ REQUIRES `expected_release_identity`, UNCONDITIONALLY. `force` means "I
   *  have read the notes for this MAJOR version" — a sentence about a specific
   *  release — and the server re-fetches the feed and resolves again after the
   *  caller clicked. Unbound, it could answer for a release published between the
   *  reading and the click, which is the one thing a major gate exists to
   *  prevent. Sent without a binding it is refused `invalid_args` rather than
   *  honoured; that is narrow (it constrains only a caller already doing
   *  something deliberate) and it is the half of the consent contract that cannot
   *  wait for an opt-in. */
  force?: boolean;
  /** The `<channel>:<version>` the caller actually reviewed. When present and
   *  the resolve produces anything else, the apply is refused `review-stale`. */
  expected_release_identity?: string;
  /** The caller ASSERTS it confirmed a staged-rollout bypass with a human.
   *
   *  ⛔ ASSERTED, NOT PROVEN, AND NOT A GATE. `rollout_pct: 0` is a STANDING
   *  DECISION — permanently, not until a number moves — so EVERY install is
   *  outside the cohort for good, and a server-side refusal would block every
   *  owner from updating at all, forever —
   *  which is why the spec puts the confirming on the client and only the AUDIT
   *  on the server. This carries the client's own report of it into the ledger so
   *  the record can distinguish a bypass someone was shown from one nobody was.
   *  Absence means "this client did not report", never "it did not confirm":
   *  every client older than this field confirms in its UI and cannot say so. */
  confirm_rollout?: boolean;
  /** The caller asks to be HELD to the release-bound contract.
   *
   *  ⛔⛔ WHY IT IS OPT-IN, AND WHY THAT IS NOT A FIG LEAF. Every consent field
   *  here is enforced only when SUPPLIED, so the hole is the ABSENCE of a claim,
   *  not a wrong one. Making the checks unconditional is not available, and not
   *  merely for now: `rollout_pct: 0` is a STANDING DECISION — whether a server
   *  applies an update by itself is the owner's preference — so EVERY install is
   *  out of cohort permanently, and requiring `confirm_rollout` fleet-wide would
   *  refuse every update from every caller that predates the field, forever. The
   *  opt-in is the long-term shape, not a stopgap waiting on a number to move. `strict` lets a caller say "I
   *  make all the claims; refuse me if I ever stop", which turns a future CLIENT
   *  REGRESSION into a refusal instead of a silent unbound apply. It does not
   *  constrain a caller that never opts in, and it is not sold as doing so.
   *
   *  ⚠ Under `strict` the server additionally requires `expected_release_identity`
   *  on every apply, and `confirm_rollout` whenever the resolved release is
   *  outside this install's rollout cohort. An older server ignores the flag. */
  strict?: boolean;
  /** The receipt the CALLER will use to ask what became of this run.
   *
   *  ⛔⛔ IT EXISTS BECAUSE A RESERVED ID IS NO USE IF ITS DELIVERY CAN FAIL. The
   *  server reserves `operation_id` before the work starts, precisely so a caller
   *  that goes away can still ask `update.operation_status` — but it travelled
   *  only on the REPLY. A socket lost between acceptance and that reply left the
   *  work running and the caller with nothing to name it by, which is the one
   *  case the reservation was for. Supplying it means the caller knows the
   *  receipt BEFORE the request leaves.
   *
   *  ⚠ THE REPLY IS STILL AUTHORITATIVE. A server older than this field ignores
   *  it (rpc args are `Record<string, unknown>` — unread keys are dropped, never
   *  rejected) and mints its own, so a caller that receives a reply must take the
   *  `operation_id` IN IT over the one it sent. They are equal on a current
   *  server and differ on an older one; only a lost reply leaves the caller
   *  relying on its own value, and against an older server that value names
   *  nothing — which is exactly where it stood before.
   *
   *  ⛔ MUST BE A FRESH UUID. It becomes the ledger entry id, so a malformed or
   *  already-used value is refused `invalid_args` rather than silently replaced:
   *  a caller holding an id the server did not use is the failure this field
   *  exists to remove. A caller retrying an uncertain send should ask
   *  `update.operation_status` about the id it already has, not send it again. */
  operation_id?: string;
}

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

export interface UpdateRollbackArgs {
  /** Caller-reserved receipt, known before the request leaves. Current servers
   *  validate freshness and use it as the `rolled_back` ledger id; older servers
   *  ignore it and their reply remains authoritative. */
  operation_id?: string;
}

export interface UpdateRollbackResponse {
  status: UpdateRollbackStatus;
  /** Opaque server-ledger receipt, present only when the restart was accepted. */
  operation_id?: string;
  /** True when the rollback also restored a pre-migration SQLite snapshot. */
  restored_snapshot?: boolean;
  /** The physical rollback completed and restart was accepted, but the durable
   * ledger receipt must be reconstructed from its rollback journal at boot. */
  receipt_pending?: boolean;
  /** The rollback decision and receipt are durable, but the physical pair swap
   * must be completed from its journal during the requested restart. */
  recovery_pending?: boolean;
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
