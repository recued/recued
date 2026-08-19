/** D-145 engine-wiring slice 3b.2 — the commit Gateway.
 *
 *  D-153 reframes execution as a flat log of atomic commits: one
 *  boundary-crossing tool call = one commit. The **Gateway** is the
 *  chokepoint that writes those commits — it wraps an ingredient
 *  executor so every call follows the crash-safe dispatch-outbox
 *  protocol (D-153 § Dispatch-outbox + crash-recovery):
 *
 *    1. write a `'pending'` commit BEFORE crossing the boundary — the
 *       durable marker that an external side-effect was about to
 *       happen, regardless of whether the call completes;
 *    2. dispatch via the wrapped executor;
 *    3. transition the commit in place to a terminal status once the
 *       outcome is observed — `'succeeded'`, `'failed'`, or
 *       `'in_doubt'` when the outcome can't be determined.
 *
 *  A commit left `'pending'` by a crash is swept to `'in_doubt'` on the
 *  next boot — no auto-resume (`CommitStore.sweepPendingToInDoubt`).
 *
 *  Slice 3b.2 ships the Gateway **inert**: this module is authored +
 *  unit-tested, but nothing wraps the engine's executor with it yet.
 *  Slice 3b.3 wires `wrapWithCommitGateway` into `execute-handler.ts`
 *  (commits go live) and builds the per-run `CommitRunIdentity` from
 *  the typed `ExecutionSource` + the run's audit `run_id`.
 *
 *  This package carries NO `@recued/engine` dependency — the layering
 *  is `engine → gateway`, so `GatewayExecutor` is declared structurally
 *  here rather than imported as the engine's `IngredientExecutor` (that
 *  import would cycle). The engine assigns a gateway-wrapped executor
 *  into `ctx.ingredientExecutor` by structural compatibility.
 *
 *  Spec: D-153 § Gateway / § Dispatch-outbox + crash-
 *  recovery / § Commit substrate.
 */

import {
  BATCH_ARGS_PREVIEW_MAX_BYTES,
  MAX_DISPATCH_DEPTH,
  canonicalArgHash,
  extractScopedDestinationEmails,
  isTempFileRef,
  projectResolvedArgs,
  resolveQualityGateDecision,
  standingClosureAdmits,
} from '@recued/contracts';
import type {
  AdmissionDecision,
  ArgHashes,
  ContractSnapshot,
  ExecutionSource,
  HashExcludeArgs,
  IngredientCategory,
  OpenProjectionComputation,
  QualityDelegationMatchContext,
  QualityGateSwitches,
  RecipeErrorCode,
  SessionGrantMatchContext,
  SessionGrantMintContext,
  StepMeta,
  StepOptions,
} from '@recued/contracts';
import type {
  CommitOutcome,
  CommitStore,
  PendingCommitInput,
} from '@recued/storage';
import { deriveCommitKind } from './commit-kind.js';
import { raiseOnAsk } from './preflight-gate.js';

// ────────────────────────────────────────────────────────────────
// Executor function shapes
// ────────────────────────────────────────────────────────────────

/** What `wrapWithCommitGateway` returns — structurally the engine's
 *  `IngredientExecutor`. Declared here, not imported from
 *  `@recued/engine`, so `packages/gateway` carries no engine
 *  dependency: the layering is `engine → gateway`, and importing the
 *  type the other way would cycle. The engine assigns a gateway-wrapped
 *  executor into `ctx.ingredientExecutor` by structural typing. */
export type GatewayExecutor = (
  slug: string,
  input: Record<string, unknown>,
  stepOutput?: Record<string, string>,
  stepOptions?: StepOptions,
  stepMeta?: StepMeta,
) => Promise<unknown>;

/** A fresh per-call signal the dispatch layer fills in. The Gateway
 *  creates one `GatewayCallProbe` per call and hands it to the wrapped
 *  `GatewayInner`; a cache composed beneath the Gateway sets
 *  `cached = true` when it served the call's output without crossing
 *  the boundary. Per-call by construction — safe under the engine's
 *  concurrent prefetch (no shared "last call" state). The Gateway
 *  copies `cached` onto the commit's outcome. */
export interface GatewayCallProbe {
  /** `true` once the dispatch layer served this call from cache. */
  cached: boolean;
}

/** The dispatch function the Gateway wraps. Same shape as the engine's
 *  `IngredientExecutor` plus a trailing `GatewayCallProbe` the dispatch
 *  layer uses to report a cache hit back to the Gateway. Use
 *  `liftExecutor` to adapt a plain executor that has no cache-hit
 *  reporting beneath it; slice 3b.3 supplies a cache-aware
 *  `GatewayInner`. */
export type GatewayInner = (
  slug: string,
  input: Record<string, unknown>,
  stepOutput: Record<string, string> | undefined,
  stepOptions: StepOptions | undefined,
  stepMeta: StepMeta | undefined,
  probe: GatewayCallProbe,
) => Promise<unknown>;

/** D-177 P2 — the per-call envelope fields the Gateway hands the session-grant
 *  lookup (N.4): everything the Gateway owns at the ask-branch. The host's
 *  `sessionGrants.match` closure adds the run's recipe identity (`recipe_id` +
 *  `recipe_hash`) to complete the `SessionGrantMatchContext` — recipe identity
 *  is per-run host state that never crosses this seam. */
export type SessionGrantGateCall = Omit<
  SessionGrantMatchContext,
  'recipe_id' | 'recipe_hash'
>;

/** D-177 P3 — the mint-side sibling of `SessionGrantGateCall`: the same
 *  per-call envelope fields plus the offered bounds (off the resumed gated
 *  step's `preflight_session_grant` marker) and the approval's audit anchor
 *  (`identity.request_id` — the paused/resumed run's `run_id`, D8). The
 *  host's `sessionGrants.mint` closure adds the run's recipe identity to
 *  complete the `SessionGrantMintContext`, exactly as `match` does. */
export type SessionGrantMintGateCall = Omit<
  SessionGrantMintContext,
  'recipe_id' | 'recipe_hash'
>;

/** D-177 P2/P3 — the session-grant lookup + consumption + mint seam (N.4 /
 *  N.5). The host builds it over the server's session-grant resolver; see
 *  `CommitGatewayDeps.sessionGrants` for the exact call protocol. */
export interface SessionGrantHooks {
  /** Match the envelope against live session grants for the call's
   *  `channel_session_id`. Read-only — never writes. Returns the matched
   *  grant's `contract_id`, or `null` (⇒ hold for approval as today). */
  match: (call: SessionGrantGateCall) => string | null;
  /** Consume one use of the matched grant at the dispatch proceed point.
   *  `false` ⇒ the grant died between match and consume — the Gateway falls
   *  back to hold (fail closed, N.4 step 4).
   *
   *  D-177 P5a — `call` carries the envelope's `canonical_payload_hash` so
   *  a `grant_mode: 'batch'` consumption can atomically CLAIM one
   *  unconsumed member with that hash (claim + `uses_remaining` decrement
   *  in one transaction — the claim IS the consumption, N.4). Exact-mode
   *  rows ignore it. Optional second arg keeps P2-era hook
   *  implementations assignable.
   *
   *  D-177 P5b — `call.pinned_projection_hash` carries the FIRE's
   *  recomputed open-projection hash so a `grant_mode: 'open'` consumption
   *  re-verifies it against the row before decrementing (defense in depth —
   *  the match already required equality, the store refuses a divergent or
   *  absent fire hash; same hash-verified posture as the batch claim). */
  /** D-177 N.11 rule 5 (slice D) — `call.destination_emails` carries the
   *  dispatch's canonical email destinations (the same extraction the match
   *  context rode) so a `grant_mode: 'scoped'` consumption RE-VERIFIES 5.d
   *  containment at the store before decrementing (the 5.a build
   *  constraint); the host's hook closure adds the per-session sender
   *  candidate index alongside. Absent ⇒ a scoped consume refuses (fail
   *  closed); exact/batch/open rows ignore it. */
  consume: (
    contract_id: string,
    call?: {
      canonical_payload_hash: string;
      pinned_projection_hash?: string;
      destination_emails?: ReadonlyArray<string>;
    },
  ) => boolean;
  /** D-177 P5a (N.10) — claim a SPECIFIC member of a `grant_mode: 'batch'`
   *  grant at the proceed point of a batch-approved RESUME dispatch (the
   *  `preflight_batch_claim` marker). Atomic claim + decrement; `false` ⇒
   *  the member was already claimed (an agent replay won the race) or the
   *  grant died — the Gateway re-raises the hold (fail closed; the
   *  approved budget is never exceeded). The host hooks make the claim
   *  idempotent PER RUN (a `foreach` gated step re-dispatches per
   *  iteration with the same marker — one member covers the whole gated
   *  step).
   *
   *  `call` carries the CURRENT dispatch's envelope hashes (codex HIGH
   *  fold): the claim is not a blind member_id spend — the store verifies
   *  the grant's `arg_shape_hash` and the member's
   *  `canonical_payload_hash` against them, so a resume whose recipe /
   *  args DRIFTED while the ask was outstanding (store-resident recipe
   *  edited mid-pause) fails the claim and re-holds with a fresh ask
   *  showing the drifted args — the member never authorizes content the
   *  human did not review. The Gateway refuses to claim at all when the
   *  dispatch carries no hashes (non-canonicalizable payload — same
   *  posture as "no hashes never grant-match").
   *
   *  Optional: absent on a pre-P5a host ⇒ the marker is treated as an
   *  unclaimable member and the dispatch re-holds (fail closed). */
  claimBatchMember?: (
    contract_id: string,
    member_id: string,
    call: { arg_shape_hash: string; canonical_payload_hash: string },
  ) => boolean;
  /** D-177 P3 (N.5/D9) — mint a session grant from a resume-admitted
   *  dispatch's envelope: called at the ask-branch when the resumed gated
   *  step carries the `preflight_session_grant` marker (the `allow_session`
   *  answer). The envelope's hashes were just computed from the MERGED
   *  resolved args — the D9 basis — by the same code path future dispatches
   *  are matched against. BEST-EFFORT, at-most-one-grant-per-approval: the
   *  host closure dedupes re-entry (a `foreach` gated step re-dispatches per
   *  iteration with the same marker — only the first mints) and never
   *  throws into the dispatch (the human approved the action; the grant is
   *  the convenience). The grant id is never returned — nothing about the
   *  grant reaches model-visible output (N.5). Optional: absent on a P2-only
   *  host ⇒ the marker is inert. */
  mint?: (call: SessionGrantMintGateCall) => void;
}

/** D-202 task 4a — the per-call envelope fields the Gateway hands the QUALITY
 *  delegation lookup at the ask-branch: the coarse `(recipe, op)`-grain identity
 *  minus the recipe halves. The host's `qualityDelegations.match` closure adds
 *  the run's recipe identity (`recipe_id` + `recipe_hash`) to complete the
 *  {@link QualityDelegationMatchContext} — exactly as `SessionGrantGateCall`
 *  does for the authorization lookup (recipe identity is per-run host state that
 *  never crosses this seam). */
export type QualityDelegationGateCall = Omit<
  QualityDelegationMatchContext,
  'recipe_id' | 'recipe_hash'
>;

/** D-202 task 4a — the QUALITY-delegation half of the ask-branch (the second
 *  gate axis beside {@link SessionGrantHooks}). When the D-177 authorization gate
 *  would ASK and no authorization session grant matched, the Gateway consults
 *  this to decide whether a standing quality delegation lets the send proceed
 *  without the per-artifact review. Read-only — a quality delegation is standing
 *  (governed by the invalidation ladder + kill-switch, not a use budget), so
 *  there is NO consume step (contrast `SessionGrantHooks.consume`). Both members
 *  are pure host reads; a throwing lookup is treated as no-skip (the ask stands —
 *  fail closed). Absent dep ⇒ no quality check runs; every `ask` holds exactly as
 *  pre-D-202 (additive — inert until the owner mints a quality delegation). */
export interface QualityGateHooks {
  /** True iff an ACTIVE quality delegation matches this dispatch's `(recipe, op)`
   *  (`matchesQualityDelegation` over the live set, recipe identity completed by
   *  the host closure). Read-only — never writes. */
  match: (call: QualityDelegationGateCall) => boolean;
  /** The owner's persisted Switch A/B kill-switch state (§4) — read at the
   *  consume site so a pause takes effect instantly (Switch B suppresses the
   *  quality skip; Switch A suppresses both axes). */
  getSwitches: () => QualityGateSwitches;
}

/** Adapt a plain executor (no cache-hit reporting) to a `GatewayInner`.
 *  The `probe` is left untouched — a lifted executor never reports
 *  `cached`. Slice 3b.3 wires a cache-aware `GatewayInner` directly. */
export const liftExecutor = (executor: GatewayExecutor): GatewayInner =>
  (slug, input, stepOutput, stepOptions, stepMeta) =>
    executor(slug, input, stepOutput, stepOptions, stepMeta);

// ────────────────────────────────────────────────────────────────
// Run identity + dependencies
// ────────────────────────────────────────────────────────────────

/** Per-run identity the Gateway stamps onto every commit it writes.
 *  Fixed for a whole recipe run — one execution request, one
 *  `ExecutionSource`, one `request_id`. Slice 3b.3 builds this in
 *  `execute-handler.ts` from the typed `ExecutionSource`, the engine's
 *  `deriveChannelSessionId` / `CorrelationTracker`, and the run's audit
 *  `run_id`, then passes it via `CommitGatewayDeps.identity`. */
export interface CommitRunIdentity {
  /** FK → the execution-request anchor (the recipe-run `AuditEntry`'s
   *  `run_id`). Every commit this run dispatches carries it. */
  request_id: string;
  /** The typed `(channel × actor)` source that dispatched the run. */
  source: ExecutionSource;
  /** Channel-owned session boundary — `deriveChannelSessionId(source)`. */
  channel_session_id: string;
  /** The ~1-min intent-burst id from the engine's `CorrelationTracker`. */
  correlation_id: string;
  /** Set only when a cognition window is open for the run; cognition
   *  ships pluggable + default-disabled, so normally absent. */
  cognition_session_id?: string;
  /** Resolved contract scope — present iff `source` carries a
   *  `contract_id` (D-161 N.4 — `'contracted_user'`, or a self-
   *  restricted `'user_self'`). */
  contract_snapshot?: ContractSnapshot;
  /** Within-process dispatch-tree depth this run's commits sit at —
   *  `0` for a top-level run. A run dispatched by another commit
   *  (sub-recipe / egress→ingress) carries the parent's depth + 1; the
   *  Gateway refuses dispatch once it exceeds `MAX_DISPATCH_DEPTH`. */
  dispatch_depth: number;
  /** R2 step 6 (write-saga) — set when this run COMPENSATES a prior
   *  commit (D-153 § cancellation: a compensating commit is a *fresh*
   *  commit whose `predecessor_commit_id` points at the row being
   *  undone). The Gateway copies it onto every commit this run writes;
   *  a compensation run is a derived single-op recipe, so exactly one
   *  boundary-crossing commit carries the link in practice. Host-only
   *  provenance (threaded via `InternalExecuteOverrides`, never a wire
   *  field) — `isCompensatingCommit` then pairs original + undo in
   *  audit / save-as-Recipe filtering. Absent on every normal run. */
  predecessor_commit_id?: string;
}

/** Everything `wrapWithCommitGateway` needs. */
export interface CommitGatewayDeps {
  /** The commit log. The Gateway writes one pending commit per call,
   *  then transitions it on outcome. */
  commitStore: CommitStore;
  /** Per-run identity. Absent → the Gateway is a no-op pass-through: it
   *  writes no commits and dispatches every call unchanged. This is
   *  slice 3b.2's inert default, and the runtime graceful-degradation
   *  path for any dispatch lacking a typed `ExecutionSource`. */
  identity?: CommitRunIdentity;
  /** Resolve an ingredient slug's category so the Gateway can derive
   *  the commit kind. Absent (or returning `undefined`) →
   *  `deriveCommitKind` falls back to `'action'`. */
  getIngredientCategory?: (slug: string) => IngredientCategory | undefined;
  /** D-157 P1 slice 4 — per-call admission probe at the dispatch
   *  boundary. The host builds a closure over the run's merged
   *  `EffectivePolicy` + the manifest registry (via
   *  `evaluatePreflightAdmission`) and passes it in. The gateway
   *  evaluates this BEFORE writing any pending commit:
   *
   *    - `'admit'` (or null / probe absent) → dispatch normally.
   *    - `'ask'`   → throw `PreflightRequiredSignal`. The engine
   *                  catches it in the step loop, snapshots `step.*`,
   *                  and ends the execution with `awaiting_approval`.
   *                  No pending commit is written — the call is paused,
   *                  not in flight; there is nothing to record yet.
   *    - `'deny'`  → fall through to normal dispatch. A per-call
   *                  `'deny'` is the rare race past the static pre-run
   *                  walk (`gateRecipeAgainstPolicy` already filters
   *                  every step on entry); surfacing it through the
   *                  normal failure path keeps a single denial UX.
   *
   *  Returning `null` is equivalent to returning `'admit'` — used by
   *  the host when the probe can't classify a call (e.g. an unknown
   *  slug). Absent dep ⇒ no per-call probe runs; behaviour is
   *  identical to pre-slice-4 (only the static pre-run walk gates).
   *
   *  M-ENFORCE-2 — the gateway passes the call's resolved `input`
   *  alongside the slug so the host can derive the dispatch's
   *  `data.*` / `connection.*` scope path (`deriveDispatchScope`,
   *  which reads `input.connection_kind` for a `connection`-kind call)
   *  and feed it to the scope fence. The arg is optional on the closure
   *  type so older zero-arg probes stay assignable.
   *
   *  Grant-foundation slice 2a — `operationId` is the dispatch's SHORT
   *  `operations`-map key (the Gateway forwards `stepMeta.surface_operation_key`,
   *  off the trusted `surface_dispatch` marker — present exactly on catalog
   *  surface dispatches). The HOST resolves it through the manifest to the
   *  DECLARED `operation_id` (the contract-scope id format) before the overlay
   *  resolve, so a standing contract scoped to specific ops admits only those.
   *  Absent (a simple-form / non-surface dispatch) ⇒ the host's op axis is
   *  unprovable, failing an op-scoped contract closed — additive, exactly as
   *  pre-slice.
   *
   *  Spec: D-157 § N.3 / A.2 / I-4 / TR-4. */
  evaluateAdmission?: (
    slug: string,
    input: Record<string, unknown>,
    operationId?: string,
  ) => AdmissionDecision | null;
  /** D-166 — record one contract use at the gateway's actual-proceed
   *  point. The host builds a closure that re-resolves the active,
   *  in-scope `.<contract_id>` overlay for the slug (a cheap synchronous
   *  store get) and decrements the matched contract's `uses_remaining`.
   *
   *  The Gateway fires it once per dispatch that crosses the boundary,
   *  SYNCHRONOUSLY before the first `await` (the `writePending` that
   *  precedes the inner call). Firing it before the Gateway yields keeps
   *  the (admission-check → decrement) window tight, so concurrent
   *  dispatches sharing a bounded contract can't both pass admission and
   *  then both dispatch past `max_uses` — a decrement parked after the
   *  yield would widen that race. It counts on success, failure, AND
   *  in_doubt alike (spec `:253` "every gateway dispatch ... counter
   *  decrements"; `:453` "on each successful match"), since all three
   *  reach the boundary. It does NOT fire when the dispatch is refused
   *  before that point: an `'ask'`/`'deny'` admission verdict or a
   *  `dispatch_depth` ceiling breach throws first. (A `writePending`
   *  failure is the one over-count — the use is reserved just before it —
   *  exactly as the pre-relocation per-call probe behaved.)
   *
   *  This is the relocation of the use-counter decrement OFF the per-call
   *  `evaluateAdmission` probe (which fired on the `'admit'` verdict, at
   *  the top of the Gateway, before dispatch). The probe never observed
   *  the approval-resume path — a paused dispatch re-enters with the same
   *  `'ask'` verdict and is admitted by the engine's resume grant
   *  (`stepMeta.preflight_admitted`) INSIDE the Gateway, so the probe's
   *  `'admit'`-gated record never fired for it. Recording at the proceed
   *  point closes that undercount: the proceed point IS reached on a
   *  resumed-and-approved dispatch.
   *
   *  Absent ⇒ no use is recorded (the host wires it only for contract-
   *  gated channels with an overlay resolver — additive, exactly as
   *  before a contract is minted).
   *
   *  Grant-foundation slice 2a — `operationId` (the SHORT surface op key,
   *  sourced identically to `evaluateAdmission`'s; the host resolves it to the
   *  DECLARED `operation_id` the SAME way) MUST mirror the admission probe's op
   *  id so the overlay's active-check agrees: a probe that admitted an op-scoped
   *  contract (op in scope) and a recordUse that re-resolved op-agnostic (no op
   *  id ⇒ INERT) would silently skip the use decrement, under-counting a bounded
   *  contract. */
  recordDispatchUse?: (slug: string, operationId?: string) => void;
  /** D-196 direct-MCP customer multiplicity reservation. Runs at the same
   * post-approval proceed point as `recordDispatchUse`, before any pending row
   * or effect. A denial throws and prevents dispatch. The request-local MCP
   * surface session commits or releases the reservation when the enclosing
   * tools/call settles, so a later recipe failure still records zero units. */
  reserveDispatchUsage?: (
    slug: string,
    input: Record<string, unknown>,
    operationId?: string,
    stepId?: string,
  ) => void;
  /** D-177 P1b — resolve a call's input to the action-identity hash basis
   *  (N.2): the SAME manifest-defaults + step-input merge the dispatch
   *  layer performs (`mergeManifestStepInput` — codex P1 fold: a
   *  connection wrapper's `connection: '{{config.x}}'` picker lives in
   *  MANIFEST defaults, so the bare step input would let an exact-repeat
   *  grant keep matching after the picker re-aims), then
   *  post-`{{config.*}}`/`{{step.*}}`/`{{item.*}}`/`{{context.*}}`
   *  resolution with `{{vault.*}}` refs left INTACT (the host builds this
   *  over the run's live stores via `resolveDeep(merged, stores,
   *  { deferVault: true })`). The Gateway receives the engine's UNRESOLVED
   *  step input (that is what `Commit.args` deliberately stores), so the
   *  hashes are computed from this merged-resolved sibling, never from
   *  `args`. `opts.surfaceDispatch` mirrors the dispatch layer's trusted
   *  lock-strip switch so the two merges stay byte-identical.
   *
   *  Absent dep, an `undefined` return (e.g. unknown slug), or a THROW
   *  (non-canonicalizable payload) ⇒ no hashes are stamped (commits carry
   *  no action identity — the inert pre-P1b shape). MUST be pure w.r.t.
   *  the input object (the host's `resolveDeep` already never mutates). */
  resolveArgsForHash?: (
    slug: string,
    input: Record<string, unknown>,
    opts: { surfaceDispatch: boolean },
  ) => Record<string, unknown> | undefined;
  /** D-177 P1b — resolve the op-declared `hash_exclude_args` volatile-
   *  exclusion list for a dispatch (N.2). `surfaceOperationKey` is the
   *  catalog gateway's threaded SHORT op key (`stepMeta.
   *  surface_operation_key`) — present exactly on catalog surface
   *  dispatches, where the op row (not the wrapper manifest) owns the
   *  declaration; the Gateway forwards it only off a trusted
   *  `surface_dispatch` marker. Absent dep, or an undefined return ⇒ no
   *  exclusions (the full payload hashes — strictly safer). */
  getHashExcludeArgs?: (
    slug: string,
    surfaceOperationKey?: string,
  ) => HashExcludeArgs | undefined;
  /** D-177 N.11 rule 5 (slice D) — resolve the dispatch's N.2 authority-path
   *  set for the scoped-grant destination extraction: the simple-form
   *  manifest's `authority_args` (∪ the wire baseline), or — off a trusted
   *  `surface_dispatch` marker — the catalog OP row's
   *  `collectOperationAuthorityPaths`. The Gateway feeds the resolved hash
   *  basis through `extractScopedDestinationEmails` over this set, LAZILY on
   *  the ask-branch only, and threads the result into the grant match +
   *  consume calls as `destination_emails` (5.d). Absent dep / undefined
   *  return ⇒ no destinations ⇒ a `'scoped'` grant never matches (fail
   *  closed — exactly the pre-slice-D posture). */
  getScopedAuthorityPaths?: (
    slug: string,
    surfaceOperationKey?: string,
  ) => readonly string[] | undefined;
  /** D-177 P5b (N.11) — compute the dispatch's OPEN PROJECTION: the
   *  taint-propagation walk over the gated call's authority-bearing args
   *  (the host closes `computeOpenProjection` over the run's recipe + live
   *  stores + manifest registry, mirroring `resolveArgsForHash`'s merge so
   *  the walk and the hash basis read the same merged-unresolved input).
   *  Returns `undefined` whenever `open` is not soundly computable for the
   *  call — manifest without an `authority_args` opt-in, a walk refusal
   *  (unclassifiable root, dynamic key, IO step output), unknown slug.
   *
   *  The Gateway evaluates it LAZILY, at most once per dispatch, and only
   *  on the `'ask'` verdict path (admit/deny never pay the walk):
   *   - the FIRE side of the N.4 `'open'` arm (the recomputed
   *     `pinned_projection_hash` rides the match context);
   *   - the MINT side of an `'open'`-mode `allow_session` resume (the D9
   *     merged-args basis — recomputed from THIS dispatch);
   *   - the raise preview (`open_projection_preview` on the held signal —
   *     the host's offer-mode feasibility signal + the ask body's
   *     pinned/varies lines).
   *  A throwing closure is treated as undefined (fail closed — `open` is an
   *  offer/match precondition, never a dispatch dependency). */
  resolveOpenProjection?: (
    slug: string,
    input: Record<string, unknown>,
    opts: { surfaceDispatch: boolean; stepId?: string },
  ) => OpenProjectionComputation | undefined;
  /** D-177 P2 — session-grant lookup + consumption (N.4). The lookup runs in
   *  the gate's ASK-BRANCH ONLY: the policy verdict computation is unchanged,
   *  `'admit'` never involves grants, and `'deny'` is never grant-overridden
   *  (D2). On an `'ask'` verdict (and no engine resume grant) the Gateway
   *  calls `match` with the call's envelope fields — requires `identity` (the
   *  `channel_session_id` binding) and the P1b hashes (a non-canonicalizable
   *  payload carries none and can never grant-match); a match ADMITS the
   *  dispatch instead of raising `PreflightRequiredSignal`, and the Gateway
   *  then calls `consume` at the actual-proceed point (synchronously before
   *  `recordDispatchUse` / `writePending`). A failed or throwing consume —
   *  the grant was revoked / expired / exhausted between match and proceed —
   *  raises the held signal after all: fail closed, no use recorded, no
   *  commit written, no boundary crossed. A throwing `match` is treated as
   *  no-match (hold — N.9.3).
   *
   *  Absent dep ⇒ no lookup runs; every `'ask'` holds exactly as pre-D-177
   *  (additive — the inert default until the host wires a resolver). */
  sessionGrants?: SessionGrantHooks;
  /** D-202 task 4a — the QUALITY-delegation lookup + Switch A/B status (the
   *  second gate axis). Consulted in the ask-branch ONLY, and ONLY after the
   *  authorization session-grant lookup missed (a matched authorization grant
   *  already admits; a varying AI draft can never authorization-match anyway —
   *  its payload hash differs each run — so a quality-delegated send always falls
   *  here). When a quality delegation matches `(recipe, op)`, is un-paused, and
   *  the whole-document conjunct passes, the Gateway composes the three-conjunct
   *  gate ({@link resolveQualityGateDecision}) against the authorization verdict
   *  captured before the review lift — a `send` verdict skips the ask; a
   *  genuine authorization ask (a contracted write, a destructive op) still holds
   *  (§12.1). Absent dep ⇒ no quality check; every `ask` holds exactly as
   *  pre-D-202 (additive — inert until the owner mints a quality delegation). */
  qualityDelegations?: QualityGateHooks;
  /** Injectable commit-id minter — a deterministic-test hook. Defaults
   *  to a prefixed UUID. */
  genCommitId?: () => string;
  /** Injectable idempotency-key minter. Defaults to a prefixed UUID. */
  genIdempotencyKey?: () => string;
  /** Injectable clock for `dispatched_at` / `completed_at`. Defaults to
   *  `Date.now`. */
  now?: () => number;
}

// ────────────────────────────────────────────────────────────────
// Depth-ceiling refusal
// ────────────────────────────────────────────────────────────────

/** D-157 P1 slice 4 (codex MAJOR fold) — thrown by the gateway when the
 *  per-call admission probe returns `'deny'`. A per-call deny is the
 *  rare race past the static pre-run walk (`gateRecipeAgainstPolicy`,
 *  which catches the common case at run start) — policy mutated between
 *  pre-walk and dispatch, or a tool slug template resolved to a tool
 *  the static walk couldn't see.
 *
 *  Carries the `RecipeErrorCode` `'RECIPE_POLICY_DENIED'` — same code
 *  the static walk surfaces — so the engine + the audit row + the
 *  upstream dispatcher see a unified deny UX regardless of which
 *  half of the gate fired. The thrown error propagates as a normal
 *  step error (the engine's step-runner catches it via
 *  `runStep`'s wrapper and maps it onto the step's `error` field). */
export class PreflightDeniedError extends Error {
  readonly code: RecipeErrorCode = 'RECIPE_POLICY_DENIED';
  /** The deny code from the policy probe (e.g. `kind_not_allowed`). */
  readonly admission_code: string;
  /** The tool slug that was denied. */
  readonly slug: string;
  constructor(slug: string, admission_code: string, detail: string) {
    super(
      `Gateway refused dispatch — preflight admission probe denied `
        + `tool '${slug}' (${admission_code}: ${detail})`,
    );
    this.name = 'PreflightDeniedError';
    this.slug = slug;
    this.admission_code = admission_code;
  }
}

/** Thrown by the Gateway when a dispatch's `dispatch_depth` exceeds
 *  `MAX_DISPATCH_DEPTH` — the within-process backstop against an
 *  unbounded egress→ingress execution loop (D-153 open question #22).
 *  The Gateway throws this BEFORE writing any commit: the dispatch is
 *  refused, the boundary is never crossed, so no pending row is needed.
 *  Carries the D-153 `RecipeErrorCode` so the engine (slice 3b.3) can
 *  surface it as a recipe error. */
export class DispatchDepthExceededError extends Error {
  /** D-153 error code — `'DISPATCH_DEPTH_EXCEEDED'`. Typed as
   *  `RecipeErrorCode` so the literal stays a valid contract code. */
  readonly code: RecipeErrorCode = 'DISPATCH_DEPTH_EXCEEDED';
  /** The depth that breached the ceiling. */
  readonly dispatch_depth: number;
  /** The ceiling that was breached — `MAX_DISPATCH_DEPTH`. */
  readonly max_dispatch_depth: number = MAX_DISPATCH_DEPTH;
  constructor(dispatch_depth: number) {
    super(
      `Gateway refused dispatch — dispatch_depth ${dispatch_depth} exceeds `
        + `MAX_DISPATCH_DEPTH (${MAX_DISPATCH_DEPTH}); runaway egress→ingress `
        + `loop backstop`,
    );
    this.name = 'DispatchDepthExceededError';
    this.dispatch_depth = dispatch_depth;
  }
}

// ────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────

/** D-157 P1 slice 4 (codex suggestion) — strip the gateway-private
 *  resume-grant markers (`preflight_admitted` + the D-165 op-identity
 *  `preflight_approved_target` + the D-177 P3 `preflight_session_grant`
 *  mint instruction) from a `StepMeta` before forwarding to the
 *  inner executor. These are the engine ↔ gateway resume-grant signals;
 *  downstream adapters have no legitimate need for them and shouldn't be
 *  able to entangle themselves with the gate substrate. Returns the original
 *  reference unchanged when the marker is absent (the common case — only the
 *  resumed gated step carries it; the two siblings are only ever set
 *  alongside `preflight_admitted`). D-201 also strips the pre-injection
 *  authority input on every sensitive surface dispatch; the connection adapter
 *  needs only the boolean sensitivity marker for generic error auditing. */
const stripPreflightMarker = (
  stepMeta: StepMeta | undefined,
): StepMeta | undefined => {
  if (stepMeta === undefined) return undefined;
  if (stepMeta.preflight_admitted !== true
    && stepMeta.surface_dispatch_authority_input === undefined) return stepMeta;
  const {
    preflight_admitted: _,
    preflight_approved_target: __,
    preflight_session_grant: ___,
    preflight_batch_claim: ____,
    surface_dispatch_authority_input: _____,
    ...rest
  } = stepMeta;
  return rest;
};

/** Mint a prefixed UUID. Mirrors the browserless-fallback shape of the
 *  engine's `commit-identity.ts` `mintCorrelationId` —
 *  `crypto.randomUUID()` when available, a v4-shaped fallback
 *  otherwise. */
const mintUuid = (prefix: string): string => {
  const g = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof g?.randomUUID === 'function') return `${prefix}-${g.randomUUID()}`;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`
    + `-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** A thrown ingredient error whose outcome is genuinely unknown — the
 *  call may or may not have landed server-side. Maps to commit status
 *  `'in_doubt'` rather than `'failed'`.
 *
 *  The single signal is the `ACTION_DELIVERY_UNCERTAIN` code. The
 *  risk-tier-aware classification is deliberately the *executor's* job,
 *  not the Gateway's: only the executor knows whether a timeout hit a
 *  write-tier call (delivery uncertain → `in_doubt`) or a read-tier one
 *  (no side-effect → plain `'failed'`). The HTTP + MCP executors
 *  already do this — an in-flight network failure on a write/admin/
 *  destructive call is normalised to `ACTION_DELIVERY_UNCERTAIN`; the
 *  Gateway must not second-guess it by also catching generic
 *  `STEP_TIMEOUT` / `NETWORK_ERROR` (that would mis-flag read failures
 *  as `in_doubt`).
 *
 *  CROSS-SLICE OBLIGATION (slice 3b.3): every executor capable of
 *  uncertain delivery MUST normalise to `ACTION_DELIVERY_UNCERTAIN`.
 *  When 3b.3 wires the Gateway into the live executors, verify that
 *  contract holds across every kind (connection / mail-send / …) — an
 *  uncertain-delivery path that surfaces a generic error instead would
 *  be mis-recorded as `'failed'`, and the boot sweep would not flag it.
 *  Every other thrown error is a confirmed failure → `'failed'`. */
const isInDoubtError = (err: unknown): boolean =>
  err !== null
  && typeof err === 'object'
  && (err as { code?: unknown }).code === 'ACTION_DELIVERY_UNCERTAIN';

/** Content isolation — a `response_capture` surface dispatch (storage-gdrive
 *  `file.download`) carries the engine-owned `__rc_capture` wire key and returns
 *  the raw file body. Its `output` is omitted from the commit record so the
 *  bytes never land in the durable commit log (the catalog gateway returns a
 *  `file_ref` instead). The marker is set ONLY by the engine's
 *  `buildApiDispatchInput`; a recipe arg with the `__rc_` prefix is stripped, so
 *  this can never be forced from recipe content. */
const isResponseCaptureCall = (input: Record<string, unknown>): boolean =>
  input.__rc_capture === '1';

/** D-200 renderer audit / D-185 invariant — a successful tool result can carry
 * a live TempFileRef for the next step, but the durable commit log must not
 * retain its absolute path after run cleanup. Preserve the live return value;
 * only the commit projection replaces temp refs with non-resolvable metadata.
 * The projection always rebuilds objects/arrays as plain data so inherited or
 * authored `toJSON` hooks cannot reintroduce a path during storage. */
const sanitizeCommitOutput = (
  value: unknown,
  depth = 0,
  ancestors: WeakSet<object> = new WeakSet<object>(),
): unknown => {
  if (
    value !== null
    && typeof value === 'object'
    && (value as { backing?: unknown }).backing === 'temp'
    && 'path' in value
  ) {
    const validTempRef = isTempFileRef(value);
    const mimeType = (value as { mime_type?: unknown }).mime_type;
    const filename = (value as { filename?: unknown }).filename;
    return {
      backing: 'temp',
      ephemeral: true,
      ...(typeof mimeType === 'string' && mimeType.length > 0
        ? { mime_type: mimeType }
        : {}),
      ...(typeof filename === 'string' && filename.length > 0
        ? { filename }
        : {}),
      ...(!validTempRef ? { malformed: true } : {}),
    };
  }
  if (value === null) return value;
  if (typeof value !== 'object') {
    if (
      typeof value === 'string'
      || typeof value === 'number'
      || typeof value === 'boolean'
    ) return value;
    return { omitted: true, reason: 'commit_output_non_json_type' };
  }
  if (depth >= 32) return { omitted: true, reason: 'commit_output_depth_limit' };
  if (ancestors.has(value)) return { omitted: true, reason: 'commit_output_cycle' };

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const copy = new Array<unknown>(value.length);
      for (let index = 0; index < value.length; index += 1) {
        if (index in value) {
          copy[index] = sanitizeCommitOutput(value[index], depth + 1, ancestors);
        }
      }
      return copy;
    }

    const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      const sanitized = sanitizeCommitOutput(item, depth + 1, ancestors);
      return [key, sanitized] as const;
    });
    const copy: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      Object.defineProperty(copy, key, {
        value: item,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
};

/** Commit evidence is best-effort and must never reverse the observed outcome
 * of an operation whose side effect already returned successfully. If a
 * pathological proxy/getter cannot be inspected safely, omit the output
 * wholesale; retaining an uninspected value could retain a temp path. */
const projectCommitOutput = (value: unknown): unknown => {
  try {
    return sanitizeCommitOutput(value);
  } catch {
    return { omitted: true, reason: 'commit_output_sanitization_failed' };
  }
};

/** Record a commit outcome, swallowing a store-write failure. The
 *  dispatch-outbox is designed to recover a missing outcome — a commit
 *  left non-terminal is swept to `'in_doubt'` on the next boot
 *  (`CommitStore.sweepPendingToInDoubt`). So a `recordOutcome` hiccup
 *  must never fail a tool call that actually succeeded, nor mask the
 *  real error of a tool call that actually failed; the boot sweep is
 *  the recovery path. */
const recordOutcomeBestEffort = async (
  store: CommitStore,
  commit_id: string,
  outcome: CommitOutcome,
): Promise<void> => {
  try {
    await store.recordOutcome(commit_id, outcome);
  } catch {
    /* swept to in_doubt on next boot — see doc above */
  }
};

// ────────────────────────────────────────────────────────────────
// wrapWithCommitGateway
// ────────────────────────────────────────────────────────────────

/** Wrap a dispatch function with the D-153 commit Gateway. The returned
 *  `GatewayExecutor` runs the crash-safe dispatch-outbox protocol
 *  around every call — pending commit → dispatch → terminal outcome —
 *  and refuses a dispatch past the `MAX_DISPATCH_DEPTH` loop ceiling.
 *
 *  With no `deps.identity` the Gateway is a no-op pass-through: it
 *  writes no commits and dispatches every call unchanged. That is the
 *  inert default (slice 3b.2 ships nothing that supplies an identity)
 *  and the runtime degradation path for a dispatch with no typed
 *  `ExecutionSource`.
 *
 *  The Gateway must be the OUTERMOST wrapper — wrapping outside any
 *  L1 / L2 cache — so a cache-served call still produces a commit
 *  (`cached: true`). A cache-aware `GatewayInner` reports the hit
 *  through the per-call `GatewayCallProbe`. */
export const wrapWithCommitGateway = (
  inner: GatewayInner,
  deps: CommitGatewayDeps,
): GatewayExecutor => {
  const genCommitId = deps.genCommitId ?? (() => mintUuid('commit'));
  const genIdempotencyKey = deps.genIdempotencyKey ?? (() => mintUuid('idem'));
  const now = deps.now ?? (() => Date.now());

  return async (slug, input, stepOutput, stepOptions, stepMeta) => {
    const identity = deps.identity;

    // D-177 P1b — canonical action identity, stamped at canonicalization.
    // Basis: the RESOLVED-minus-vault payload (deps.resolveArgsForHash),
    // projected to its JSON wire form (resolved-undefined optional refs
    // erase exactly as the dispatched JSON will), with the op-declared
    // volatile exclusions removed from the value hash. The catalog
    // gateway's `surface_operation_key` is honored only off the trusted
    // `surface_dispatch` marker — a recipe-forged key (buildStepMeta never
    // copies either field from recipe JSON) cannot select a different
    // op's exclusion list.
    //
    // D-177 P2 — computed ABOVE the admission probe (it used to sit past
    // the depth backstop) so the envelope exists when the probe's
    // ask-branch runs the session-grant lookup (N.4); the same hashes are
    // stamped onto the pending commit below — the commit records exactly
    // what was matched. Identity-gated: the hashes feed the commit stamp
    // and the grant match, and both require run identity. The resolved
    // `connection` wire arg is kept alongside — it pins the grant scope's
    // connection axis at match time.
    //
    // FAIL-CLOSED-TO-ABSENT: `canonicalArgHash` throws on a payload it
    // cannot represent unambiguously (non-finite numbers, Dates, …). The
    // commit then carries NO hashes — and an absent hash can never match
    // a session grant (N.4 requires hash equality; the Gateway skips the
    // lookup entirely), so the degraded form holds for approval rather
    // than over-matching. The dispatch itself proceeds unchanged: the
    // identity stamps, it does not gate.
    const surfaceDispatch = stepMeta?.surface_dispatch === true;
    const authorityInput = surfaceDispatch
      && stepMeta?.surface_dispatch_authority_input !== undefined
      ? stepMeta.surface_dispatch_authority_input as Record<string, unknown>
      : input;
    const sensitiveSurfaceDispatch = surfaceDispatch
      && stepMeta?.surface_dispatch_sensitive === true;
    if (sensitiveSurfaceDispatch
      && stepMeta?.surface_dispatch_authority_input === undefined) {
      throw new Error('sensitive surface dispatch is missing its pre-injection authority input');
    }
    let argHashes: ArgHashes | undefined;
    let resolvedConnectionName: string | undefined;
    // D-177 P5a — the resolved-args wire projection, kept for the batch-ask
    // member preview when a hold is raised (N.10 items rendering). Secret-
    // free by construction: the hash basis resolves with `deferVault`, so
    // `{{vault.*}}` refs survive as placeholders. Captured only when the
    // hashes computed (a non-canonicalizable payload is never a batch
    // member) and only under the size cap (an over-sized preview is
    // dropped; the hold still carries its hashes).
    let argsPreview: Record<string, unknown> | undefined;
    // D-177 N.11 rule 5 (slice D) — the resolved hash basis, retained for the
    // scoped-grant destination extraction below (same merged-resolved sibling
    // the hashes cover; secret-free — `{{vault.*}}` stays a placeholder).
    let resolvedArgsForScoped: Record<string, unknown> | undefined;
    if (identity !== undefined && deps.resolveArgsForHash !== undefined) {
      try {
        const resolved = deps.resolveArgsForHash(slug, authorityInput, { surfaceDispatch });
        if (resolved !== undefined) {
          resolvedArgsForScoped = resolved;
          const excludePaths = deps.getHashExcludeArgs?.(
            slug,
            surfaceDispatch ? stepMeta?.surface_operation_key : undefined,
          );
          const projected = projectResolvedArgs(resolved);
          argHashes = canonicalArgHash(
            projected,
            excludePaths !== undefined ? { excludePaths } : {},
          );
          // Byte-accurate cap (codex LOW fold) — the budget is durable-row
          // bytes, not UTF-16 code units; non-ASCII previews must not
          // overshoot it.
          if (
            new TextEncoder().encode(JSON.stringify(projected)).length
            <= BATCH_ARGS_PREVIEW_MAX_BYTES
          ) {
            argsPreview = projected;
          }
          resolvedConnectionName =
            typeof resolved.connection === 'string' && resolved.connection.length > 0
              ? resolved.connection
              : undefined;
        }
      } catch {
        /* cannot compute action identity → stamp nothing (see above) */
      }
    }
    // The envelope-identity fields every hold raise attaches (N.10) — the
    // host registers batch members off the caught signal's hashes/preview.
    const raiseContext = {
      slug,
      ...(argHashes !== undefined
        ? {
            arg_shape_hash: argHashes.arg_shape_hash,
            canonical_payload_hash: argHashes.canonical_payload_hash,
          }
        : {}),
      ...(argsPreview !== undefined ? { args_preview: argsPreview } : {}),
    };

    // D-177 P5b (N.11) — the dispatch's open projection, computed lazily at
    // most once and only where the ask-branch needs it (see the dep's doc).
    // Identity + hashes gated like the grant lookup: a dispatch that can't
    // canonicalize can neither match nor mint an open grant, so it never
    // pays the walk either. `undefined` is memoized too (a refused walk is
    // refused for the whole dispatch).
    let openProjectionMemo: OpenProjectionComputation | undefined;
    let openProjectionComputed = false;
    const openProjectionOnce = (): OpenProjectionComputation | undefined => {
      if (!openProjectionComputed) {
        openProjectionComputed = true;
        if (
          deps.resolveOpenProjection !== undefined
          && identity !== undefined
          && argHashes !== undefined
        ) {
          try {
            openProjectionMemo = deps.resolveOpenProjection(slug, authorityInput, {
              surfaceDispatch,
              ...(stepMeta?.step_id !== undefined
                ? { stepId: stepMeta.step_id }
                : {}),
            });
          } catch {
            openProjectionMemo = undefined; // fail closed — never a dispatch dependency
          }
        }
      }
      return openProjectionMemo;
    };
    // D-177 N.11 rule 5 (slice D) — the dispatch's canonical email
    // destinations for the `'scoped'` grant arm, computed lazily at most once
    // and only on the ask-branch (admit/deny never pay the walk). Gated like
    // the grant lookup: identity + hashes + the retained resolved basis. A
    // throwing extraction is `undefined` — no destinations ⇒ the scoped arm
    // fails closed to ask (5.d/5.i.3).
    let scopedDestinationsMemo: string[] | undefined;
    let scopedDestinationsComputed = false;
    const scopedDestinationsOnce = (): string[] | undefined => {
      if (!scopedDestinationsComputed) {
        scopedDestinationsComputed = true;
        if (
          deps.getScopedAuthorityPaths !== undefined
          && identity !== undefined
          && argHashes !== undefined
          && resolvedArgsForScoped !== undefined
        ) {
          try {
            const paths = deps.getScopedAuthorityPaths(
              slug,
              surfaceDispatch ? stepMeta?.surface_operation_key : undefined,
            );
            if (paths !== undefined) {
              scopedDestinationsMemo = extractScopedDestinationEmails(
                resolvedArgsForScoped,
                paths,
              );
            }
          } catch {
            scopedDestinationsMemo = undefined; // fail closed — never a dispatch dependency
          }
        }
      }
      return scopedDestinationsMemo;
    };

    // Raise context enriched with the open preview — built at raise time so
    // the memo (computed in the match branch below) is reused, and a raise
    // that never consulted grants (resume fallbacks) still renders the
    // pinned/varies lines when the walk succeeds.
    const raiseContextWithOpen = (): typeof raiseContext & {
      open_projection_preview?: OpenProjectionComputation['preview'];
    } => {
      const p = openProjectionOnce();
      return {
        ...raiseContext,
        ...(p !== undefined ? { open_projection_preview: p.preview } : {}),
      };
    };

    // D-177 P2 — set when the ask-branch matched a live session grant: the
    // dispatch is grant-admitted, and the Gateway must CONSUME one use at
    // the actual-proceed point below (N.4 step 4). The decision is kept so
    // a failed consumption can fall back to the held signal — typed to the
    // 'ask' variant so the fallback raise provably throws. P5b: the FIRE's
    // recomputed open-projection hash rides along so an `'open'`-mode
    // consumption is hash-verified at the store (defense in depth).
    let sessionGrantAdmit:
      | {
          contract_id: string;
          decision: Extract<AdmissionDecision, { verdict: 'ask' }>;
          pinned_projection_hash?: string;
          /** Slice D — the destinations the `'scoped'` match was evaluated
           *  against, kept so the proceed-point consume RE-VERIFIES the same
           *  containment at the store (5.a). */
          destination_emails?: ReadonlyArray<string>;
        }
      | undefined;
    // D-177 P5a — set when a batch-approved RESUME dispatch (the
    // `preflight_batch_claim` marker) re-entered on an `'ask'` verdict: the
    // approval admits it, and the Gateway must CLAIM the named member at
    // the proceed point (the claim IS the consumption — N.4). A failed
    // claim re-raises the hold. NOT set when the resume re-evaluates to
    // `'admit'` (policy loosened mid-ask — no approval authority is needed,
    // so no member burns; the unclaimed member stays absorbable).
    let batchClaimPending:
      | {
          contract_id: string;
          member_id: string;
          decision: Extract<AdmissionDecision, { verdict: 'ask' }>;
        }
      | undefined;

    // D-157 P1 slice 4 (codex MAJOR fold) — per-call preflight
    // admission probe. Fires BEFORE the identity-gated commit-writing
    // branch so a policy-gated dispatch that lacks commit substrate
    // (no `identity` / no `commitStore`) still gets approval gating —
    // the static walk + this per-call gate are the two halves of the
    // policy enforcement boundary, and short-circuiting the per-call
    // half because there's no commit log to write to would silently
    // bypass the user's approval requirement. Per-call deny fires
    // here too, raising a recipe error before any dispatch.
    //
    // `'ask'` raises `PreflightRequiredSignal`; the engine catches it
    // in its step loop, snapshots `step.*`, ends the execution with
    // `awaiting_approval`. No commit row needs to be written (the
    // dispatch is paused, not in flight); the host is responsible
    // for persisting the checkpoint + raising `notification.ask`.
    //
    // `'deny'` raises a `RecipeError`-shaped throw with code
    // `RECIPE_POLICY_DENIED` — same surface as the static pre-run
    // walk's denial. A per-call deny is the rare race past the
    // static walk (policy mutated between pre-walk and dispatch).
    //
    // `'admit'` (or null / probe absent) falls through to normal
    // dispatch.
    //
    // Resume admittance — `stepMeta.preflight_admitted: true` is set
    // by the engine on the gated step's call when re-instantiating
    // past a checkpoint (TR-5). The probe still runs (a policy
    // mutated between pause and resume can still hard-deny), but an
    // `'ask'` verdict is admitted: the upstream approval is the
    // authoritative signal for THIS gate's call. A `'deny'` verdict
    // still blocks.
    if (deps.evaluateAdmission) {
      // Grant-foundation slice 2a — forward the trusted SHORT op key (catalog
      // surface dispatches only; same sourcing as the hash-exclude / session-
      // grant op id below) so the host's overlay resolve can honor an op-scoped
      // standing contract. A simple-form dispatch carries none ⇒ undefined.
      const decision = deps.evaluateAdmission(
        slug,
        authorityInput,
        surfaceDispatch ? stepMeta?.surface_operation_key : undefined,
      );
      if (decision !== null) {
        if (decision.verdict === 'deny') {
          throw new PreflightDeniedError(slug, decision.code, decision.detail);
        }
        if (decision.verdict === 'ask') {
          // D-165 follow-on (op-identity binding) — honor the resume grant
          // ONLY when the approved identity names THIS slug. Position alone
          // (the gated step id, via `preflight_admitted`) is insufficient: a
          // recipe re-authored while paused could resolve the same gated
          // step id to a DIFFERENT simple-form tool, and the stale approval
          // must not admit it. Absent target or slug mismatch re-raises (a
          // fresh checkpoint + ask for the current tool — fail closed). A
          // catalog delegate carries a `preflight_approved_target` the
          // catalog gate re-pointed to the delegate slug (it already
          // verified the catalog op's full triple + the delegate's declared
          // risk), so an authorized delegate still matches here.
          const resumeApproved =
            stepMeta?.preflight_admitted === true
            && stepMeta.preflight_approved_target?.ingredient_slug === slug;
          // D-207 follow-on — the door's owner-CONFIRMED standing closure, the
          // SAME predicate the catalog gate reads. A door recipe dispatches
          // through BOTH gates (a pack/API op via the catalog, a simple-form
          // kernel op like `core.mail.send` via this one), so a closure honored
          // in only one place would keep asking for half of what the owner
          // confirmed. The op axis here is the kernel op id the admission
          // resolved, matching what `mintDoorContract` wrote its grant rows
          // from.
          // ⛔ IDENTITY IS OPTIONAL HERE — an identity-less dispatch must HOLD,
          // never admit. Dereferencing it unguarded turned two existing
          // "identity-less ask" tests red, which is exactly the failure a
          // fail-closed predicate is supposed to make impossible.
          // ⛔⛔ `identity.source`, and this was `identity.execution_source` —
          // a field that DOES NOT EXIST on `CommitRunIdentity`. It read
          // `undefined`, so the predicate's contract-id match could never
          // succeed and THIS GATE NEVER ADMITTED ANYTHING. A fail-closed
          // predicate reading a nonexistent field is indistinguishable from one
          // working correctly: the door simply kept asking, which is exactly
          // what a door without the opt-in does. Only `tsc` saw it — vitest
          // stayed green, because nothing exercised a kernel op on an opted-in
          // door. "One predicate, two gates" was true of the predicate and
          // false of the second gate.
          const standingAdmit = identity !== undefined && standingClosureAdmits(
            identity.contract_snapshot,
            identity.source,
            surfaceDispatch ? stepMeta?.surface_operation_key ?? slug : slug,
            decision.risk_tier,
            decision.authorization_provenance.lift_reason,
          );
          // D-177 P3 — mint on a resume-admitted dispatch whose gated step
          // carries the `allow_session` mint instruction (N.5). THIS is the
          // D9 point: `argHashes` above was computed from the MERGED resolved
          // args (an approve-with-edits resume merged `arg_overrides` before
          // resolution), by the very code path a future dispatch's match
          // context comes from — so the grant pins exactly what the human
          // approved and provably matches its own repeat. Requirements mirror
          // the match branch (identity for the session binding; hashes for
          // the action identity — a non-canonicalizable payload mints
          // nothing, exactly as it can never match); the hook is best-effort
          // and never blocks the human-approved dispatch (a throwing mint is
          // swallowed; the host logs). The mint result is deliberately not
          // read — nothing about the grant reaches the dispatch output (N.5).
          //
          // Tier pin (codex HIGH fold): the marker carries the tier the ask
          // SHOWED the human; mint only when the resume decision re-evaluates
          // to exactly that tier. A policy/manifest mutation that
          // re-classified the call while the ask was outstanding still
          // RESUMES (the approval admits the action) but mints nothing — a
          // grant must pin what was approved, never what drifted.
          if (
            resumeApproved
            && stepMeta?.preflight_session_grant !== undefined
            && stepMeta.preflight_session_grant.risk_tier === decision.risk_tier
            && deps.sessionGrants?.mint !== undefined
            && identity !== undefined
            && argHashes !== undefined
            && (
              decision.authorization_provenance.pre_lift_approval === 'never'
              || decision.authorization_provenance.pre_lift_approval === 'ask'
            )
          ) {
            try {
              // D-177 P5b (N.11) — an `'open'`-mode instruction recomputes
              // the open projection from THIS resume dispatch (the D9
              // merged-args basis: an approve-with-edits resume pins the
              // edited values; the same closure future fires are matched
              // with computes it, so the grant provably matches its own
              // repeat). Recompute failure — the manifest's opt-in was
              // withdrawn mid-pause, a store mutated a walked root into an
              // unclassifiable shape — degrades to NO mint (fail closed;
              // the human-approved resume proceeds regardless). Any other
              // marker mode mints the P3 exact grant unchanged.
              const wantsOpen =
                stepMeta.preflight_session_grant.grant_mode === 'open';
              const openComputation = wantsOpen ? openProjectionOnce() : undefined;
              if (!wantsOpen || openComputation !== undefined) {
                deps.sessionGrants.mint({
                  channel: identity.source.channel,
                  actor: identity.source.actor,
                  channel_session_id: identity.channel_session_id,
                  ingredient_slug: slug,
                  // Trusted op key + resolved connection — same sourcing rules
                  // as the match branch below (surface_dispatch-gated key; the
                  // resolved `connection` wire arg from the hash basis).
                  ...(surfaceDispatch
                    && stepMeta.surface_operation_key !== undefined
                    ? { operation_id: stepMeta.surface_operation_key }
                    : {}),
                  ...(resolvedConnectionName !== undefined
                    ? { connection_name: resolvedConnectionName }
                    : {}),
                  risk_tier: decision.risk_tier,
                  pre_lift_approval:
                    decision.authorization_provenance.pre_lift_approval,
                  arg_shape_hash: argHashes.arg_shape_hash,
                  canonical_payload_hash: argHashes.canonical_payload_hash,
                  // entity_scope deliberately absent — nothing stamps it yet
                  // (P1b reserved slot); grant-side absence keeps the N.4
                  // both-absent-or-equal clause satisfiable.
                  ttl_ms: stepMeta.preflight_session_grant.ttl_ms,
                  max_uses: stepMeta.preflight_session_grant.max_uses,
                  approved_action_ref: identity.request_id,
                  ...(wantsOpen && openComputation !== undefined
                    ? {
                        grant_mode: 'open' as const,
                        pinned_projection_hash:
                          openComputation.pinned_projection_hash,
                        open_projection: openComputation.projection,
                      }
                    : {}),
                });
              }
            } catch {
              /* best-effort — the approval resumes regardless (N.5) */
            }
          }
          // D-177 P5a (N.10) — a batch-approved resume carries the member-
          // claim marker: the upstream batched approval admits THIS
          // dispatch, and the named member must be atomically claimed at
          // the proceed point below (the claim is the consumption — N.4;
          // an agent replay that claimed it first wins the budget and this
          // dispatch re-holds). Stash the 'ask' decision so the failed-
          // claim fallback provably raises.
          if (resumeApproved && stepMeta?.preflight_batch_claim !== undefined) {
            batchClaimPending = {
              contract_id: stepMeta.preflight_batch_claim.contract_id,
              member_id: stepMeta.preflight_batch_claim.member_id,
              decision,
            };
          }
          // ⛔ The standing closure short-circuits the SAME branch a resume
          // does: the owner already answered this question at bind, so a
          // session-grant lookup would be a second answer to it.
          if (!resumeApproved && !standingAdmit) {
            // D-177 P2 — session-grant lookup, ask-branch ONLY (N.4): the
            // verdict computation above is untouched, 'admit' never involves
            // grants, and 'deny' threw before this point (grants never
            // override deny — D2). The lookup needs run identity (the
            // channel_session_id binding) and the P1b hashes (a payload that
            // couldn't canonicalize stamps none and must hold — N.4 hash
            // equality is unsatisfiable, so we skip the call outright). The
            // host's `match` adds the run's recipe identity and evaluates
            // the N.4 common + per-mode predicate against live grants; a
            // throwing lookup is a no-match (hold — fail closed, N.9.3).
            // On a match the dispatch is ADMITTED: no signal is raised, and
            // the proceed point below consumes one use before the boundary.
            let grantId: string | null = null;
            // D-177 P5b — the fire's recomputed projection hash, when the
            // walk classifies this dispatch. Computed BEFORE the lookup so
            // an `'open'` grant can be matched (the N.4 open arm fails
            // closed without it); a refused walk supplies nothing and only
            // exact/batch rows remain matchable — fail closed.
            const fireOpenHash = openProjectionOnce()?.pinned_projection_hash;
            // Slice D — the scoped arm's destination tokens, computed before
            // the lookup (the N.4 scoped arm fails closed without them; a
            // non-email authority shape supplies nothing and only the other
            // modes remain matchable). The host's `match` closure pairs them
            // with the per-session sender candidate index (5.d).
            const fireDestinations = scopedDestinationsOnce();
            if (
              deps.sessionGrants !== undefined
              && identity !== undefined
              && argHashes !== undefined
            ) {
              try {
                grantId = deps.sessionGrants.match({
                  channel: identity.source.channel,
                  actor: identity.source.actor,
                  channel_session_id: identity.channel_session_id,
                  ingredient_slug: slug,
                  // The catalog op's SHORT key, trusted exactly as the P1b
                  // exclusion lookup trusts it — only off a surface_dispatch
                  // marker the engine set (a recipe-forged key never binds).
                  ...(surfaceDispatch
                    && stepMeta?.surface_operation_key !== undefined
                    ? { operation_id: stepMeta.surface_operation_key }
                    : {}),
                  // The resolved `connection` wire arg (from the hash basis)
                  // pins the grant scope's connection axis; absent on kinds
                  // that dispatch without one.
                  ...(resolvedConnectionName !== undefined
                    ? { connection_name: resolvedConnectionName }
                    : {}),
                  risk_tier: decision.risk_tier,
                  pre_lift_approval:
                    decision.authorization_provenance.pre_lift_approval,
                  arg_shape_hash: argHashes.arg_shape_hash,
                  canonical_payload_hash: argHashes.canonical_payload_hash,
                  // entity_scope deliberately absent — nothing stamps it yet
                  // (P1b reserved slot); the predicate's both-absent-or-equal
                  // clause then requires grant-side absence too.
                  ...(fireOpenHash !== undefined
                    ? { open_pinned_projection_hash: fireOpenHash }
                    : {}),
                  ...(fireDestinations !== undefined
                    ? { destination_emails: fireDestinations }
                    : {}),
                });
              } catch {
                grantId = null;
              }
            }
            if (grantId === null) {
              // D-202 task 4a — the second gate axis. No authorization session
              // grant matched, so today this holds for approval. Before raising,
              // consult a QUALITY delegation: the owner can, per `(recipe, op)`,
              // delegate the "is this AI draft good?" review while authorization
              // stays independently checked every send (§12.1). The
              // three-conjunct gate consumes the authorization provenance
              // captured BEFORE the review lift (a
              // lift-driven owner send resolves to `admit`; a contracted write /
              // destructive op stays `ask` and holds regardless of quality) with
              // the matching, un-paused delegation and the whole-document
              // conjunct. Only a `send` verdict skips the ask. Gated on
              // `identity` (the dispatch/recipe scope); a throwing lookup or
              // absent dep fails closed to the ask. Behaviour-
              // preserving at zero delegations: no match ⇒ `quality_not_delegated`
              // ⇒ raise, exactly as pre-D-202.
              //
              // D-211 Slice 3 removed the former args-blind risk reconstruction:
              // source/profile and owner tightening now survive here verbatim.
              let qualitySkip = false;
              // D-202 Slice 1b — the quality-RELEVANCE marker: `true` iff the
              // three-conjunct gate held the send purely because no quality
              // delegation matched (`quality_not_delegated`) — authorization
              // ADMITTED. Those are exactly the asks a quality delegation would
              // remove, so the owner's answer to them is the reject-driven
              // learner's signal (seam contract §2). Distinct from
              // `authorization_ask` (the owner is approving AUTHORIZATION, not
              // content quality) — that reason leaves this false, so an authz
              // approval never trains the quality axis. Threaded onto the raised
              // ask so the answer-path resumer can record a `QualityDelegationSignal`.
              let qualityRelevant = false;
              if (deps.qualityDelegations !== undefined && identity !== undefined) {
                try {
                  const qualityDecision = resolveQualityGateDecision({
                    authorization_provenance:
                      decision.authorization_provenance,
                    qualityDelegationMatches: deps.qualityDelegations.match({
                      ingredient_slug: slug,
                      ...(surfaceDispatch
                        && stepMeta?.surface_operation_key !== undefined
                        ? { operation_id: stepMeta.surface_operation_key }
                        : {}),
                    }),
                    switches: deps.qualityDelegations.getSwitches(),
                    // v1 whole-document placeholder — always passes; the §13
                    // consistency mechanism is deferred (never fully delegated,
                    // §12.2, so it stays a structural conjunct here).
                    wholeDocumentPasses: true,
                  });
                  qualitySkip = qualityDecision.verdict === 'send';
                  qualityRelevant = qualityDecision.reason === 'quality_not_delegated';
                } catch {
                  qualitySkip = false; // fail closed — the ask stands
                  qualityRelevant = false; // and records no learner signal
                }
              }
              // A quality skip proceeds WITHOUT a grant consume: a quality
              // delegation is standing (§5), not use-bounded, so no
              // `sessionGrantAdmit` is set and the proceed point burns nothing.
              if (!qualitySkip) {
                raiseOnAsk(decision, {
                  ...raiseContextWithOpen(),
                  // Mark the ask quality-relevant so the answer path records the
                  // reject-driven signal. Attached only when true; a non-quality
                  // ask carries no marker (behaviour-preserving).
                  ...(qualityRelevant ? { quality_relevant: true } : {}),
                });
              }
            } else {
              sessionGrantAdmit = {
                contract_id: grantId,
                decision,
                ...(fireOpenHash !== undefined
                  ? { pinned_projection_hash: fireOpenHash }
                  : {}),
                ...(fireDestinations !== undefined
                  ? { destination_emails: fireDestinations }
                  : {}),
              };
            }
          }
        }
      }
    }

    // D-157 P1 slice 4 (codex suggestion fold) — keep the
    // `preflight_admitted` marker gateway-private: strip it before
    // forwarding `stepMeta` to the inner executor so downstream
    // adapters (cache, HTTP, MCP) never observe the engine's
    // resume-grant signal. Defense-in-depth — the inner has no
    // legitimate need for it, and an adapter that branched on it
    // would be entangling itself with the gate substrate.
    const forwardedStepMeta = stripPreflightMarker(stepMeta);

    // No-op pass-through — without run identity the Gateway has no
    // request_id / source / depth to stamp, so it writes no commit and
    // dispatches the call unchanged. The preflight probe above
    // already ran, so a policy-gated channel without commit substrate
    // still gets approval gating; this branch just skips the commit
    // log because there's nothing to anchor against.
    if (identity === undefined) {
      // D-177 P5a proceed point (no-op variant) — a batch-approved resume
      // claims its member even on the identity-less degradation path
      // (defense-in-depth: a batch hold is only ever registered under run
      // identity, so this is unreachable in practice — but the marker
      // must never dispatch unclaimed). Same fail-closed fallback as the
      // identity-stamped path below.
      if (batchClaimPending !== undefined) {
        let claimed = false;
        try {
          // Hash-verified claim (codex HIGH fold): no envelope hashes ⇒
          // no claim ⇒ re-hold (the member must never authorize content
          // the human did not review).
          claimed =
            argHashes !== undefined
            && deps.sessionGrants?.claimBatchMember !== undefined
            && deps.sessionGrants.claimBatchMember(
              batchClaimPending.contract_id,
              batchClaimPending.member_id,
              {
                arg_shape_hash: argHashes.arg_shape_hash,
                canonical_payload_hash: argHashes.canonical_payload_hash,
              },
            );
        } catch {
          claimed = false;
        }
        if (!claimed) {
          raiseOnAsk(batchClaimPending.decision, raiseContextWithOpen());
        }
      }
      // D-166 proceed point (no-op variant) — count one contract use
      // before crossing the boundary, synchronously ahead of the `inner`
      // dispatch (the same reservation-before-yield discipline as the
      // identity-stamped path below, so it never widens the bounded-
      // contract use race). No commit anchor on this degradation path, but
      // a use is independent of the commit log — the static + per-call
      // gates already authorized the call.
      deps.reserveDispatchUsage?.(
        slug,
        authorityInput,
        surfaceDispatch ? stepMeta?.surface_operation_key : undefined,
        stepMeta?.step_id,
      );
      deps.recordDispatchUse?.(
        slug,
        // slice 2a — mirror the admission probe's op id so the overlay
        // active-check agrees (else a bounded op-scoped contract under-counts).
        surfaceDispatch ? stepMeta?.surface_operation_key : undefined,
      );
      return inner(slug, input, stepOutput, stepOptions, forwardedStepMeta, {
        cached: false,
      });
    }

    // #22 loop backstop — refuse a dispatch whose depth is past the
    // ceiling BEFORE writing any commit. No boundary is crossed, so no
    // pending row is needed; the throw propagates as a recipe error. A
    // grant-admitted dispatch refused here consumed nothing — the use
    // burns only at the proceed point below.
    if (identity.dispatch_depth > MAX_DISPATCH_DEPTH) {
      throw new DispatchDepthExceededError(identity.dispatch_depth);
    }

    const commit_id = genCommitId();
    const pending: PendingCommitInput = {
      commit_id,
      kind: deriveCommitKind(deps.getIngredientCategory?.(slug)),
      ingredient: slug,
      // Pre-D-153-multi-tool: the ingredient exposes one callable tool,
      // identified by the same slug. When multi-tool ingredients land
      // and the executor signature gains a tool name, `tool` splits off.
      tool: slug,
      args: authorityInput,
      ...(argHashes !== undefined
        ? {
            arg_shape_hash: argHashes.arg_shape_hash,
            canonical_payload_hash: argHashes.canonical_payload_hash,
          }
        : {}),
      source: identity.source,
      ...(identity.contract_snapshot !== undefined
        ? { contract_snapshot: identity.contract_snapshot }
        : {}),
      channel_session_id: identity.channel_session_id,
      ...(identity.cognition_session_id !== undefined
        ? { cognition_session_id: identity.cognition_session_id }
        : {}),
      correlation_id: identity.correlation_id,
      dispatch_depth: identity.dispatch_depth,
      idempotency_key: genIdempotencyKey(),
      dispatched_at: now(),
      request_id: identity.request_id,
      ...(identity.predecessor_commit_id !== undefined
        ? { predecessor_commit_id: identity.predecessor_commit_id }
        : {}),
    };

    // D-177 P2 proceed point — consume the matched session grant FIRST,
    // synchronously, before any other proceed-point effect (N.4 step 4:
    // "consume at the dispatch proceed point; for 'batch' the member claim
    // IS the consumption"). The whole match → consume segment runs without
    // an intervening `await`, so two concurrent dispatches cannot both
    // match-then-consume a final use; the consume itself re-verifies
    // liveness atomically and FAILS when the grant died in between
    // (revoked / expired / exhausted). A failed or throwing consume falls
    // back to the hold this grant absorbed: the held signal is raised
    // BEFORE `recordDispatchUse` and `writePending`, so a held dispatch
    // records no contract use, writes no commit, and never crosses the
    // boundary — fail closed. A use burned on a subsequently-failed
    // dispatch is acceptable (conservative; same posture as the contract
    // use counter below).
    if (sessionGrantAdmit !== undefined) {
      let consumed = false;
      try {
        consumed =
          deps.sessionGrants !== undefined
          && deps.sessionGrants.consume(
            sessionGrantAdmit.contract_id,
            // D-177 P5a — the envelope hash selects the member a
            // `grant_mode: 'batch'` consumption claims (exact rows ignore
            // it). Present whenever a grant matched: the lookup is gated
            // on `argHashes !== undefined` above. P5b — the fire's
            // recomputed projection hash rides along so an `'open'`-mode
            // consumption is store-verified against the row (defense in
            // depth; absent on a non-open match and ignored by
            // exact/batch rows).
            argHashes !== undefined
              ? {
                  canonical_payload_hash: argHashes.canonical_payload_hash,
                  ...(sessionGrantAdmit.pinned_projection_hash !== undefined
                    ? {
                        pinned_projection_hash:
                          sessionGrantAdmit.pinned_projection_hash,
                      }
                    : {}),
                  // Slice D — the scoped arm's containment is RE-VERIFIED at
                  // the store (5.a); the host closure pairs these with the
                  // live sender candidate index.
                  ...(sessionGrantAdmit.destination_emails !== undefined
                    ? {
                        destination_emails:
                          sessionGrantAdmit.destination_emails,
                      }
                    : {}),
                }
              : undefined,
          );
      } catch {
        consumed = false;
      }
      if (!consumed) {
        raiseOnAsk(sessionGrantAdmit.decision, raiseContextWithOpen());
      }
    }

    // D-177 P5a proceed point — a batch-approved resume claims its named
    // member FIRST, synchronously, exactly like the grant consumption
    // above (the claim IS the consumption — N.4; the member was minted
    // from this very hold's envelope at answer time). A failed or
    // throwing claim — the member was already claimed by an agent replay,
    // or the grant was revoked / expired — re-raises the hold BEFORE
    // `recordDispatchUse` / `writePending`: no contract use recorded, no
    // commit written, no boundary crossed, and the approved member budget
    // is never exceeded. The host hooks dedupe re-claims within one run
    // (a `foreach` gated step re-dispatches per iteration with the same
    // marker — the first iteration claims, the rest ride it).
    if (batchClaimPending !== undefined) {
      let claimed = false;
      try {
        // Hash-verified claim (codex HIGH fold) — see the no-op variant
        // above: no envelope hashes ⇒ no claim ⇒ re-hold.
        claimed =
          argHashes !== undefined
          && deps.sessionGrants?.claimBatchMember !== undefined
          && deps.sessionGrants.claimBatchMember(
            batchClaimPending.contract_id,
            batchClaimPending.member_id,
            {
              arg_shape_hash: argHashes.arg_shape_hash,
              canonical_payload_hash: argHashes.canonical_payload_hash,
            },
          );
      } catch {
        claimed = false;
      }
      if (!claimed) {
        raiseOnAsk(batchClaimPending.decision, raiseContextWithOpen());
      }
    }

    // D-166 proceed point — record one contract use here, SYNCHRONOUSLY
    // before the first `await` (`writePending`, below). The decrement is
    // the use "reservation": running it before the Gateway yields keeps
    // the (admission-check → decrement) window as tight as the per-call
    // probe's old synchronous decrement was. A decrement parked AFTER the
    // yield would widen that window so two concurrent dispatches sharing a
    // bounded contract could both pass admission and then both cross the
    // boundary past `max_uses`. It fires on every dispatch that reaches
    // the boundary — success, failure, OR in_doubt (spec `:253` "every
    // gateway dispatch ... counter decrements") — and, unlike the probe's
    // old `'admit'`-gated record, on the approval-resume path too: a
    // resumed dispatch re-enters with verdict `'ask'`, is admitted by the
    // engine's resume grant INSIDE the Gateway above, and still reaches
    // this point. Placed after the depth backstop, so a depth-refused call
    // is not counted; a (rare) `writePending` failure below over-counts by
    // one, exactly as the pre-relocation probe did.
    deps.reserveDispatchUsage?.(
      slug,
      authorityInput,
      surfaceDispatch ? stepMeta?.surface_operation_key : undefined,
      stepMeta?.step_id,
    );
    deps.recordDispatchUse?.(
      slug,
      // slice 2a — mirror the admission probe's op id so the overlay
      // active-check agrees (else a bounded op-scoped contract under-counts).
      surfaceDispatch ? stepMeta?.surface_operation_key : undefined,
    );

    // writePending failure propagates — without the durable pending
    // row the crash-safety marker is absent, so the Gateway must NOT
    // cross the boundary. The call fails before any side-effect.
    await deps.commitStore.writePending(pending);

    const probe: GatewayCallProbe = { cached: false };
    try {
      const result = await inner(
        slug,
        input,
        stepOutput,
        stepOptions,
        forwardedStepMeta,
        probe,
      );
      await recordOutcomeBestEffort(deps.commitStore, commit_id, {
        status: 'succeeded',
        // Content isolation (storage-gdrive `file.download`): a
        // `response_capture` surface dispatch returns the raw file body
        // (base64) so the catalog gateway can ingest it into the CAS and return
        // a `file_ref` with the bytes stripped. Those bytes must NEVER be
        // persisted as commit output — omit it for the capture call (the
        // file_ref is the durable artifact). Marker is the engine-owned
        // `__rc_capture` wire key (a recipe can never set it).
        ...(result !== undefined
          && !sensitiveSurfaceDispatch
          && !isResponseCaptureCall(input)
          ? { output: projectCommitOutput(result) }
          : {}),
        completed_at: now(),
        ...(probe.cached ? { cached: true } : {}),
      });
      return result;
    } catch (err) {
      await recordOutcomeBestEffort(deps.commitStore, commit_id, {
        status: isInDoubtError(err) ? 'in_doubt' : 'failed',
        completed_at: now(),
      });
      throw err;
    }
  };
};
