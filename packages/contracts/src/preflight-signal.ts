/** D-157 P1 — preflight pause signal.
 *
 *  The `(channel × actor × contract_id)` policy matrix can yield an
 *  `'ask'` verdict for a boundary-crossing call (D-157 § N.3 / A.2). The
 *  call cannot dispatch until a human approves; the run cannot hold the
 *  call (a preflight `ask` can be outstanding for minutes or days; a
 *  held in-memory promise leaks + dies on restart — I-4). Instead the
 *  engine snapshots the run's `step.*` state, ends the execution, and
 *  hands the snapshot back so the host can mint + persist a
 *  `Checkpoint` (D-157 § A.2). The host re-instantiates a fresh
 *  execution from that checkpoint on `Approve` (the resume path —
 *  `ExecutionContext.resumeFrom`).
 *
 *  `PreflightRequiredSignal` is the signal that crosses the
 *  engine ↔ gateway seam to drive that pause. The gateway wrapper around
 *  `ctx.ingredientExecutor` THROWS this signal when its admission gate
 *  yields `'ask'` (D-157 P1 slice 4 wires the real gateway; the engine
 *  pause/resume slice — this one — exercises it via test fixtures).
 *  The engine CATCHES it distinctly from a normal step error: instead of
 *  recording an error in the step log, it snapshots `step.*`, ends the
 *  run, and reports `awaiting_approval` in `ExecutionResult`.
 *
 *  Cross-package by design — the gateway / the host / the engine each
 *  hold one identity for the signal. Lives in `@recued/contracts` so
 *  both sides import the same name. The guard uses the `name` marker
 *  rather than `instanceof` so it stays true across realms / bundles
 *  (the engine and the gateway can resolve to different module
 *  instances in some build setups; a name check is portable, an
 *  `instanceof` check is not).
 *
 *  The signal carries an optional `PreflightSignalDetails` payload —
 *  `tool_slug` / `risk_tier` / `reason` — populated by the gateway at
 *  raise time (D-157 server-wiring slice). The engine catches the
 *  signal, reads those fields off the instance, and forwards them on
 *  `ExecutionResult.awaiting_approval` so the host can render the
 *  eventual `notification.ask` body with the structured reason. The
 *  *engine* still supplies the position fields (`gated_step_id` from
 *  the step it was running + the cloned `step_state` snapshot out of
 *  `ctx.stores.step`) — those come from the surrounding execution
 *  context, not the signal. A legacy raise site that constructs the
 *  signal without `details` (just a message) leaves the structured
 *  fields undefined and the host falls back to a bare ask.
 *
 *  Spec: D-157 § N.3 / N.8 / A.2 / I-4 / I-5.
 */

import type {
  AuthorizationProvenance,
  OperationApproval,
} from './ingredient-catalog.js';
import type { ForeachCheckpointProgress } from './foreach-checkpoint.js';

/** Stable `name` marker for `PreflightRequiredSignal` — the value the
 *  `isPreflightRequiredSignal` guard tests for. Exported so the gateway
 *  + the engine can both reference the literal without `instanceof`
 *  (cross-realm / cross-bundle safe). */
export const PREFLIGHT_REQUIRED_SIGNAL_NAME = 'PreflightRequiredSignal';

/** D-211 Slice 2 — a global operation-specific standing owner ruling
 * offered beside approval. The answer path re-validates this persisted shape
 * before writing it through the authoritative override rpc core. */
export type PreflightOverrideOffer =
  | {
      kind: 'never_ask';
      ingredient_id: string;
      operation_id: string;
      /** Exact authored operation reviewed when this action was offered. */
      op_hash: string;
      approval: 'never';
    }
  | {
      kind: 'relax_to_ask';
      ingredient_id: string;
      operation_id: string;
      /** Exact authored operation reviewed when this action was offered. */
      op_hash: string;
      approval: 'ask';
    };

/** Structured fields the gateway attaches to a `PreflightRequiredSignal`
 *  so the engine — and the host that surfaces the eventual
 *  `notification.ask` — see the *why* the gate fired without parsing the
 *  error message. The fields are advisory: the engine treats their
 *  presence as best-effort and never branches on them. Surfaced through
 *  `ExecutionResult.awaiting_approval` so the host can populate
 *  `PreflightAskContext` (and therefore the ask's body) verbatim. */
export interface PreflightSignalDetails {
  /** The ingredient slug the gated dispatch targeted. */
  tool_slug?: string;
  /** The tool's `RiskTier` as a string — the ask body renders it as
   *  `"… (risk_tier='write')"`. Stringified at the raise site to keep
   *  this contract package free of cross-imports from policy types. */
  risk_tier?: string;
  /** Free-form reason from the policy decision's `detail`. */
  reason?: string;
  /** D-165 follow-on (op-identity binding) — the resolved identity of the
   *  gated call. Forwarded through `ExecutionResult.awaiting_approval` onto
   *  the `Checkpoint.approved_target` so resume can verify the re-resolved
   *  call still targets the same operation before honoring the approval
   *  (catalog gate sets all three; the simple-form gate sets only
   *  `ingredient_slug`). Distinct from `tool_slug` (a display field that the
   *  catalog gate sets to the operation id). */
  ingredient_slug?: string;
  operation_id?: string;
  connection_name?: string;
  /** D-177 P5a (N.10) — the held call's P1b action-identity hashes,
   *  attached by the commit Gateway's raise so the host can register the
   *  hold as a batch-ask member (the member's `canonical_payload_hash` is
   *  its identity in the eventual `grant_mode: 'batch'` mint). Absent on
   *  a payload that could not canonicalize — such a hold can never be a
   *  batch member (N.4: no hashes never grant-match) and falls back to a
   *  per-hold ask. */
  arg_shape_hash?: string;
  canonical_payload_hash?: string;
  /** D-177 P5a (N.10) — the resolved-args wire projection of the gated
   *  call, for the reviewable items rendering (`summary` +
   *  `args_preview`). Secret-free by construction: the hash basis
   *  resolves with `{{vault.*}}` refs left intact (`deferVault`), so the
   *  preview carries placeholders, never credentials. Size-capped at the
   *  raise site (`BATCH_ARGS_PREVIEW_MAX_BYTES`); absent when over-cap or
   *  unavailable. */
  args_preview?: Record<string, unknown>;
  /** D-177 P5b (N.11) — the held call's open-projection pinned/varies
   *  summary, attached when the Gateway's walk fully classified the
   *  dispatch's authority-bearing args. PRESENCE is the host's
   *  `grant_mode: 'open'` feasibility signal (the offer upgrades to open
   *  exactly when this rode the signal — proven on this very dispatch);
   *  the lines render in the ask body so the human sees what stays pinned
   *  and what may vary (rule 7). Human-facing only: the agent projection
   *  (`projectRunResultForAgent`) never carries it (N.9.1). */
  open_projection_preview?: {
    pinned: ReadonlyArray<{ label: string; value: string }>;
    varying: ReadonlyArray<{ label: string; origin: string }>;
  };
  /** D-202 Slice 1b — the QUALITY-relevance marker. `true` iff the commit
   *  Gateway raised this ask because authorization ADMITTED (the review lift was
   *  the only hold) and no quality delegation matched — the `quality_not_delegated`
   *  three-conjunct verdict. Those are exactly the asks a quality delegation would
   *  remove, so the owner's answer to them is the reject-driven learner's SIGNAL
   *  (approve → `quality_good`, reject → `quality_bad`). Threaded onto the
   *  `Checkpoint` so the answer-path resumer can `append` a `QualityDelegationSignal`.
   *  Absent (undefined) on every non-quality ask (`authorization_ask`, a legacy
   *  raise site, or a gate with no quality dep) ⇒ no signal is recorded — behaviour-
   *  preserving. Spec: D-202 §3 (S4). */
  quality_relevant?: boolean;
  /** D-217 § 6.1 — the AMPLIFICATION BOUND of a multi-request act.
   *
   *  ⛔ **N requests per approval is a multiplier a reviewer must be able to see
   *  BEFORE approving.** Every other gated call in this system is one approval
   *  buying one request; a chunked upload is one approval buying up to 103 — and
   *  an ask that says "an upload" while meaning "103 requests and 512 MB leaving
   *  this machine" is asking the owner to consent to something it did not
   *  describe. The bound is fixed before the first dispatch (§ 8a), so it is
   *  knowable at raise time; nothing about it is an estimate.
   *
   *  ⚠ It is NOT sufficient that the numbers are inside `args_preview`. That is
   *  raw resolved JSON — a reader looking for the blast radius should not have
   *  to find `__cu_walk.count` in it. Absent for every ordinary single-request
   *  hold. */
  egress_bound?: {
    /** Requests this ONE approval authorizes — the reviewable multiplier. */
    readonly requests: number;
    /** Plaintext bytes that will leave if the walk completes. */
    readonly total_bytes: number;
  };
  /** D-211 — standing-ruling affordance for this exact held operation. */
  owner_override_offer?: PreflightOverrideOffer;
  /** D-211 — stored approval that resolved below the effective risk floor. */
  approval_clamped_from?: OperationApproval;
  /** D-209 §1.7 — authorization posture before review/quality lifts. */
  authorization_provenance?: AuthorizationProvenance;
}

/** Thrown from inside an `ingredientExecutor` when a boundary-crossing
 *  call needs preflight approval — D-157 P1's pause trigger. The engine
 *  catches it distinctly from a normal error in its step loop.
 *
 *  An `Error` subclass so it propagates through every Promise / try-catch
 *  the engine threads — including `runForeach`'s per-iteration catch —
 *  without special wiring. The engine's catch sites re-throw it on sight
 *  so it can reach the step loop that owns the pause-and-end control
 *  flow. */
export class PreflightRequiredSignal extends Error {
  /** Marker name read by `isPreflightRequiredSignal`. Bound on the
   *  instance (not just the prototype) so the guard works even if a
   *  caller stringifies + reconstructs the error (e.g. via
   *  structured-clone on a worker boundary). */
  readonly name: string = PREFLIGHT_REQUIRED_SIGNAL_NAME;
  /** Engine-authored only: exact progress when this signal crossed a foreach. */
  foreach_progress?: ForeachCheckpointProgress;
  /** Host-created continuation marker. This waits for an existing child run;
   * it is never itself an owner approval request. */
  preapproval_nested_wait?: { child_run_id: string };

  /** Optional structured fields the gateway attaches at raise time. The
   *  engine reads these out of the caught signal and surfaces them on
   *  `ExecutionResult.awaiting_approval` so the host can render the
   *  `notification.ask` body with the structured reason. Absent on legacy
   *  raise sites that only supply a message — the engine falls back to a
   *  bare pause in that case. */
  readonly tool_slug?: string;
  readonly risk_tier?: string;
  readonly reason?: string;
  /** D-165 follow-on (op-identity binding) — resolved identity of the gated
   *  call, surfaced for the `Checkpoint.approved_target` so resume can
   *  re-verify the call before honoring the approval. */
  readonly ingredient_slug?: string;
  readonly operation_id?: string;
  readonly connection_name?: string;
  /** D-177 P5a (N.10) — the held call's action-identity hashes + resolved
   *  args preview, for batch-ask member registration. See
   *  `PreflightSignalDetails`. */
  readonly arg_shape_hash?: string;
  readonly canonical_payload_hash?: string;
  readonly args_preview?: Record<string, unknown>;
  /** D-177 P5b (N.11) — open-grant feasibility + pinned/varies rendering.
   *  See `PreflightSignalDetails`. */
  readonly open_projection_preview?: PreflightSignalDetails['open_projection_preview'];
  /** D-202 Slice 1b — quality-relevance marker (`quality_not_delegated` ask).
   *  See `PreflightSignalDetails.quality_relevant`. */
  readonly quality_relevant?: boolean;
  /** D-217 § 6.1 — how many requests this ONE approval authorizes, and how
   *  many bytes leave. See `PreflightSignalDetails['egress_bound']`. */
  readonly egress_bound?: PreflightSignalDetails['egress_bound'];
  readonly owner_override_offer?: PreflightOverrideOffer;
  readonly approval_clamped_from?: OperationApproval;
  readonly authorization_provenance?: AuthorizationProvenance;

  /** ⚠⚠ **This copies field-by-field, so a new member of
   *  `PreflightSignalDetails` is SILENTLY ABSENT on the instance until it is
   *  added below.** Declaring it on the interface and the class typechecks
   *  perfectly and populates nothing — the raise site passes it, the reader
   *  gets `undefined`, and nothing anywhere complains. (D-217 § 6.1 lost an
   *  hour to exactly this.) The enumeration is deliberate — `Object.assign`
   *  would let a raise site smuggle arbitrary keys onto a signal the engine
   *  forwards — so the cost is real and the discipline is: ADD YOUR FIELD
   *  HERE TOO. */
  constructor(message?: string, details?: PreflightSignalDetails) {
    super(message ?? 'preflight approval required');
    if (details?.tool_slug !== undefined) this.tool_slug = details.tool_slug;
    if (details?.risk_tier !== undefined) this.risk_tier = details.risk_tier;
    if (details?.reason !== undefined) this.reason = details.reason;
    if (details?.ingredient_slug !== undefined) {
      this.ingredient_slug = details.ingredient_slug;
    }
    if (details?.operation_id !== undefined) {
      this.operation_id = details.operation_id;
    }
    if (details?.connection_name !== undefined) {
      this.connection_name = details.connection_name;
    }
    if (details?.arg_shape_hash !== undefined) {
      this.arg_shape_hash = details.arg_shape_hash;
    }
    if (details?.canonical_payload_hash !== undefined) {
      this.canonical_payload_hash = details.canonical_payload_hash;
    }
    if (details?.args_preview !== undefined) {
      this.args_preview = details.args_preview;
    }
    if (details?.open_projection_preview !== undefined) {
      this.open_projection_preview = details.open_projection_preview;
    }
    if (details?.egress_bound !== undefined) {
      this.egress_bound = details.egress_bound;
    }
    if (details?.quality_relevant !== undefined) {
      this.quality_relevant = details.quality_relevant;
    }
    if (details?.owner_override_offer !== undefined) {
      this.owner_override_offer = details.owner_override_offer;
    }
    if (details?.approval_clamped_from !== undefined) {
      this.approval_clamped_from = details.approval_clamped_from;
    }
    if (details?.authorization_provenance !== undefined) {
      this.authorization_provenance = details.authorization_provenance;
    }
  }
}

/** True when `value` is a `PreflightRequiredSignal` — name-based,
 *  cross-realm/bundle safe (vs. `instanceof`, which fails when the
 *  thrower and the catcher resolve to different module instances). The
 *  engine's pause-catch sites read this. */
export const isPreflightRequiredSignal = (
  value: unknown,
): value is PreflightRequiredSignal => {
  if (value === null || typeof value !== 'object') return false;
  return (value as { name?: unknown }).name === PREFLIGHT_REQUIRED_SIGNAL_NAME;
};
