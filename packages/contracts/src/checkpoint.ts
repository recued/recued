/** D-157 P1 — preflight checkpoint substrate.
 *
 *  D-157's preflight-approval gate: when the `(channel × actor ×
 *  contract_id)` policy matrix yields an `ask` verdict for a
 *  boundary-crossing call, the engine cannot hold the call — a
 *  preflight `ask` can be outstanding for minutes or days, and a held
 *  in-memory promise leaks and dies on restart. Instead the engine
 *  mints a `Checkpoint`, persists it, and ENDS the execution. The
 *  paused run lives entirely on disk; nothing is held in memory (I-4).
 *
 *  On `Approve` the gateway's preflight `on_answer` re-instantiates a
 *  FRESH execution from the checkpoint that continues PAST the gate —
 *  resume in mechanism only, a new seeded execution, not a revived
 *  process. On `Deny` the run aborts. Either way the checkpoint is
 *  then consumed (deleted from the `CheckpointStore`).
 *
 *  This file is contracts-only — the `Checkpoint` shape + its guard.
 *  The `CheckpointStore` persistence substrate is `@recued/storage`;
 *  the engine pause/resume path + the gateway preflight flow are later
 *  D-157 P1 slices.
 *
 *  Spec: D-157 § N.3 / A.2 / I-4 / I-6.
 */

import type { ContractSnapshot, ExecutionSource } from './commits.js';
import {
  isOperationApproval,
  type AuthorizationProvenance,
  type OperationApproval,
} from './ingredient-catalog.js';
import type { PiiLedgerStoreSnapshot } from './pii-alias.js';
import type { PreflightOverrideOffer } from './preflight-signal.js';
import { isOperationSpecHash } from './owner-operation-override.js';
import type { GatedActionSettlementMode } from './gated-action.js';
import type { ForeachCheckpointProgress } from './foreach-checkpoint.js';

// ────────────────────────────────────────────────────────────────
// Checkpoint — the resumable state of a preflight-gated run
// ────────────────────────────────────────────────────────────────

/** D-165 follow-on (op-identity binding) — the resolved identity of the
 *  boundary-crossing call the user approved at the gate. Persisted on the
 *  checkpoint at pause so resume can verify the re-resolved call still
 *  targets the SAME operation before honoring the approval. The catalog
 *  gate (`@recued/engine`) captures the full triple; the simple-form gate
 *  captures only `ingredient_slug` (it has no operation / connection axis).
 *
 *  Why it matters: the gated step's `connection_name` is engine-resolved
 *  from the step's `connection` field — a `{{config.*}}` / `{{ref}}` that
 *  can resolve to a DIFFERENT connection if config changed while the run
 *  was paused (and a re-authored recipe can change the operation literal at
 *  the same step id). Position-only resume would wrongly honor an approval
 *  for connection A on a now-resolved connection B. Binding resume to this
 *  target re-raises a fresh ask for the drifted call instead (fail closed). */
export interface PreflightApprovedTarget {
  /** Ingredient slug the gated dispatch targeted. */
  ingredient_slug?: string;
  /** Catalog operation key (catalog gate only). */
  operation_id?: string;
  /** Connection record name the operation dispatched against (catalog gate
   *  only). */
  connection_name?: string;
}

/** D-211 Slice 2 — durable presentation/action metadata for an approval hold.
 * The original ask normally persists its own payload; this checkpoint copy
 * keeps the same affordance and clamp warning when boot recovery must re-raise
 * an ask after notification delivery failed. */
export interface PreflightCheckpointContext {
  tool_slug?: string;
  connection_name?: string;
  risk_tier?: string;
  reason?: string;
  /** Fixed amplification bound shown on the approval and copied to the
   * operation receipt after restart recovery. */
  egress_bound?: { readonly requests: number; readonly total_bytes: number };
  /** Trusted host classification captured when the gate fires. Result JSON is
   * never allowed to opt itself into asynchronous handoff semantics. */
  gated_action_settlement_mode?: GatedActionSettlementMode;
  owner_override_offer?: PreflightOverrideOffer;
  approval_clamped_from?: OperationApproval;
  authorization_provenance?: AuthorizationProvenance;
  /** D-161 Part B (display) — the `ExecutionSource.actor` of the run that
   *  raised this hold, captured ONLY when it is an outside actor
   *  (`anonymous` / `contracted_user`). The owner's own runs (`user_self`,
   *  and `system` schedules acting on their authority) leave it absent, so
   *  the ask gains a line exactly when there is something to say.
   *
   *  ⛔ WHY IT IS TOLD TO THE OWNER AT ALL. The taint layer already makes an
   *  outside-origin run unable to ride a standing grant — that is WHY these
   *  holds reach the owner (`reception-recipe-runner.ts`). The ask never said
   *  so: it opens "Recipe X wants to run …" whether the run was started by the
   *  owner at a keyboard or by a stranger posting a public form. Naming the
   *  starter is the one fact the reviewer cannot recover from anything else on
   *  the card.
   *
   *  ⛔ WIDENED `string`, NOT `Actor`, AND DELIBERATELY SO — the same choice
   *  `risk_tier` above makes. `isCheckpoint` rejects the WHOLE checkpoint on a
   *  member it cannot validate, and a rejected checkpoint is a PENDING
   *  APPROVAL THE OWNER LOSES. This field only ever prints a sentence, so a
   *  future `Actor` member read back by an older binary must degrade to "no
   *  line", never to "hold discarded". Renderers match known values and emit
   *  nothing for the rest. */
  origin_actor?: string;
}

/** D-182 §8 (GRANT HALF, Inc B-writes) — the recipe-LESS raw-op door hold.
 *
 *  When a door's raw catalog op (`recued_op_<publisher>.<pack>.<operation>`)
 *  hits an `ask` verdict — at either the contract `policy_matrix` admission OR
 *  the catalog gateway's per-op preflight — there is no recipe / run to
 *  checkpoint (the spec forbids synthesizing a fake recipe, §6/§8). Instead the
 *  recipe-less dispatch (`backend/server/src/raw-op-dispatch.ts`) freezes the
 *  whole held call onto THIS block and persists a `Checkpoint` carrying it. The
 *  resume re-dispatches these frozen values directly through the SAME catalog
 *  Gateway (now admitted past the ask via `StepMeta.preflight_admitted` +
 *  `preflight_approved_target`) — no `executeRecipe`, no recipe lookup, no run
 *  anchor. Self-contained: the answer round-trip + crash recovery ride the
 *  D-158 notification block (the open ask persists with the `checkpoint_id`),
 *  not an `AuditEntry` anchor (a raw-op checkpoint has none).
 *
 *  The held call is re-dispatched VERBATIM — `op_args` are frozen here, so
 *  there is no `{{config.*}}` / connection re-resolution drift the recipe path
 *  must guard against; the resume's `preflight_approved_target` is exactly
 *  `(catalog_slug, operation, connection_name)`. */
export interface RawOpCheckpoint {
  /** The full Tier-P wire op id (`<publisher>.<pack>.<operation>`) — display
   *  + agent-facing message + audit continuity. */
  op_id: string;
  /** The backing catalog ingredient slug the op resolves to (the dispatch
   *  target + the grant's ingredient axis). */
  catalog_slug: string;
  /** The catalog operation key (the dispatch's operation + the grant's
   *  operation axis). */
  operation: string;
  /** The enrolled connection the op binds (Model 1 — the reserved `connection`
   *  arg, already stripped from `op_args`). `''` for an `ai` / `storage` op
   *  that resolves none; the grant binds the connection axis only when set. */
  connection_name: string;
  /** The op args AS DISPATCHED — the reserved `connection` arg removed, every
   *  other key verbatim. Re-dispatched unchanged on resume (frozen — no
   *  re-resolution). `{{vault.*}}` / `{{config.*}}` refs (if any) stay intact,
   *  same posture as `Checkpoint.recipe_snapshot`; the connection adapter
   *  re-resolves them against the fresh vault at resume dispatch. */
  op_args: Record<string, unknown>;
  /** The door's MCP `ExecutionSource` (channel `'mcp'`, actor
   *  `'contracted_user'`, the `tool_call_id` / `mcp_token_id` / `contract_id`).
   *  Rebuilds the recipe-less `ExecutionContext` + supplies the grant's
   *  channel / actor / session axes at resume. Carries no decrypted
   *  credentials. */
  execution_source: ExecutionSource;
  /** The per-token contract snapshot the hold was admitted under (the door's
   *  `buildMcpContractSnapshot`). Re-fed to the resume's admission re-check so
   *  a policy that tightened to a hard deny while the ask was outstanding fails
   *  the resume closed. Absent on a contract-free caller. */
  contract_snapshot?: ContractSnapshot;
  /** D-182 §8 follow-on — the door inbound-token's BOUND contract id at hold
   *  time (`McpDeps.boundContractId`), present ONLY when the token was
   *  contract-bound; absent for an unbound token. The resume re-probes THIS
   *  contract's liveness via `ContractOverlayResolver.isContractLive` (the same
   *  kill-switch the MCP transport applies at request entry) and fails the
   *  resume CLOSED if it was revoked / expired / exhausted while the ask was
   *  outstanding — so revoking a door's contract blocks an already-held write
   *  too, not just fresh Gate-A calls. Stored separately from
   *  `execution_source.contract_id` because that field falls back to the token
   *  id for an UNBOUND token (not a real contract), which must NOT be
   *  liveness-probed (it would fail-closed a legitimately unbound resume). */
  bound_contract_id?: string;
  /** The operation's effective `RiskTier` as surfaced on the hold (string —
   *  the offer's tier-drift precondition + the `mintRawOpGrant` tier). */
  risk_tier: string;
  /** The held call's arg key-shape hash (off the preflight signal) — the
   *  `raw_op` grant's `arg_shape_hash`. Absent when the payload could not
   *  canonicalize (no grant mintable — `allow_session` degrades to a plain
   *  one-shot approval). */
  arg_shape_hash?: string;
  /** The held call's exact canonical payload hash (off the preflight signal) —
   *  the recipe-less exact identity the `raw_op` grant binds. Absent ⇒ as
   *  `arg_shape_hash`. */
  canonical_payload_hash?: string;
  /** The MCP `tool_call_id` burst correlation id the hold was raised under, so
   *  the resume's op-level audit row keeps the same `origin_unit_id`. */
  correlation_id?: string;
}

/** The resumable state of a preflight-gated run — the run's `step.*`
 *  namespace snapshot plus the gated step id, minted by the engine at a
 *  preflight-approval gate and persisted to the `CheckpointStore`
 *  (`@recued/storage`).
 *
 *  Grain: one `Checkpoint` is one paused run. A run gates at most once
 *  at a time — the gate ENDS the execution, so no running process
 *  could gate again until the run is re-instantiated.
 *
 *  What the checkpoint carries — and what it deliberately does not:
 *
 *  - It carries `step_state` — the `step.*` namespace, the ONLY
 *    namespace that accumulates run state. `config` / `meta` /
 *    `context` / `connection` are recipe-static or caller-injected, so
 *    the CHECKPOINT does not carry them; re-seeding them is the engine
 *    pause/resume slice's concern, not the substrate's.
 *
 *    ⚠ THAT IS NOT THE SAME AS RE-RESOLVING THEM FRESH — and this
 *    comment previously said "re-seeded at re-instantiation exactly as
 *    for a fresh run", which is the opposite of what the slice does.
 *    The resumer replays the run anchor's FROZEN snapshots:
 *    `config: { ...anchor.config_snapshot }` and
 *    `context: { ...anchor.context_snapshot }`
 *    (`backend/server/src/preflight-resumer.ts:486` / `:494-496`), so
 *    the resumed gated step dispatches against exactly the values the
 *    gate evaluated. A resumed run is byte-identical to the paused one
 *    BY DESIGN: the owner approved a specific call against specific
 *    values, and re-resolving would silently change what they approved.
 *    `connection` IS re-resolved, but the `approved_target` guard
 *    re-asks on drift rather than dispatching against it (below).
 *    `d-165-op-identity-binding-drift.test.ts` states this correctly in
 *    its own header; `packages/engine/src/__tests__/`
 *    `pause-resume-ambient-sealing.test.ts` pins what actually stays
 *    sealed across a pause while the world moves underneath it.
 *  - It deliberately does NOT carry `vault`. A checkpoint is persisted
 *    to disk; decrypted credentials must never land there. `vault` is
 *    re-seeded fresh at re-instantiation — which also correctly picks
 *    up any credential rotation that happened while the run was paused.
 *    The gated step's authored `args` keep their `{{vault.*}}` refs
 *    intact (the commit substrate captures `args` pre-resolution), so
 *    re-resolution against the fresh vault stays faithful.
 *  - It deliberately does NOT carry an `ask_id`. The checkpoint is
 *    minted BEFORE the gateway calls `notification.ask` — no `ask_id`
 *    exists yet (D-157 § N.3 step 2). The gateway records the
 *    `checkpoint_id` ↔ `ask_id` link on the run anchor (the recipe-run
 *    `AuditEntry`), not on the checkpoint (§ N.3 step 3).
 *
 *  Spec: D-157 § A.2 / N.3. */
export interface Checkpoint {
  /** UUID — the checkpoint's stable identity, engine-minted when the
   *  preflight gate fires. The gateway's preflight `notification.ask`
   *  handler payload is `{ checkpoint_id }`; the boot sweep + the
   *  `on_answer` re-instantiation both address the checkpoint by it. */
  checkpoint_id: string;
  /** FK to the execution-request anchor — the recipe-run `AuditEntry`'s
   *  `run_id` (D-153 § Execution-request anchor). The paused run's
   *  anchor carries the `'awaiting_approval'` `RunAnchorStatus`; a boot
   *  sweep pairs an `awaiting_approval` anchor with its checkpoint via
   *  `CheckpointStore.listByRun(run_id)`. */
  run_id: string;
  /** Recipe whose run this checkpoint belongs to. Re-instantiation
   *  loads the recipe definition to continue it; the exact version is
   *  cross-checkable against the anchor's `recipe_hash`.
   *
   *  D-182 §8 — OPTIONAL on the recipe-LESS raw-op door checkpoint (the
   *  `{@link Checkpoint.raw_op}` discriminant is set instead): a raw catalog op
   *  the LLM held over MCP has no recipe and no run anchor (nothing synthesizes
   *  a fake recipe — §6/§8; that would pollute Memory's `recipe_insights`). The
   *  guard requires it for a recipe-bound checkpoint (`raw_op` absent) and
   *  requires it ABSENT for a raw-op checkpoint — a clean partition both ways. */
  recipe_id?: string;
  /** Hash of the recipe definition before connection lowering and automatic
   * execution rewrites. New checkpoints always carry it. Stored-recipe resume
   * compares the current definition against this value before an approved
   * effect may dispatch, so an edit cannot inherit an old owner decision.
   * Optional only for checkpoints written before this field existed. */
  recipe_source_hash?: string;
  /** R2 step 6 — the recipe definition itself, for a run whose recipe
   *  is NOT in the recipe store: an INLINE dispatch (the R2 transient
   *  resolve-at-dispatch path — deliberately never persisted) or a
   *  derived saga-compensation recipe. Without it a paused inline run
   *  could never resume (`recipe_id` lookup → not found). The snapshot
   *  is the RESOLVED recipe the engine actually ran, so resume is
   *  byte-identical to the paused run AND integrity-checkable: the
   *  resumer verifies `hashRecipe(recipe_snapshot)` against the paused
   *  anchor's `recipe_hash` and fails closed on a mismatch (a tampered
   *  on-disk checkpoint cannot smuggle a different recipe past the
   *  user's approval). Carries no RESOLVED vault/config values — step
   *  args keep their `{{vault.*}}` / `{{config.*}}` refs intact, same
   *  as `step_state`'s posture. (A caller that embeds a literal secret
   *  in an inline recipe's args lands it here — exactly as the commit
   *  log already retains that call's `args` un-redacted; a write-time
   *  redaction/encryption policy spans both substrates and is a noted
   *  follow-on, not a new exposure class this field introduces.) Absent
   *  for store-resident recipes (the common path, byte-identical to
   *  pre-R2-step-6 checkpoints). */
  recipe_snapshot?: Record<string, unknown>;
  /** R2 step 6 — present only when the paused run is a saga
   *  COMPENSATION run: the commit it undoes. A compensation pauses at
   *  the preflight gate like any write; the resume re-instantiation
   *  must keep stamping the compensating link onto the dispatched
   *  commit (`CommitRunIdentity.predecessor_commit_id`), and the
   *  checkpoint is the only durable carrier across the pause. Threaded
   *  back through the resumer's internal-only channel — never a wire
   *  field. */
  predecessor_commit_id?: string;
  /** Id of the step whose boundary-crossing call the policy matrix
   *  gated — D-157 § A.2's "position". Re-instantiation resumes the run
   *  AT this step, now past the gate, so the gated call dispatches
   *  exactly once and no step before it re-runs (TR-5).
   *
   *  D-182 §8 — OPTIONAL on the recipe-LESS raw-op door checkpoint: a raw op
   *  is a single dispatch with no step loop to resume "at" — the held op
   *  identity + frozen args live on `{@link Checkpoint.raw_op}` and the resume
   *  re-dispatches them directly. Required for, and only for, a recipe-bound
   *  checkpoint (the guard partitions on `raw_op`). */
  gated_step_id?: string;
  /** D-165 follow-on (op-identity binding) — the resolved identity of the
   *  gated call the user is approving, captured at pause. On resume the
   *  catalog gate (`@recued/engine`) honors the approval ONLY when the
   *  re-resolved `(ingredient_slug, operation_id, connection_name)` still
   *  matches this — a drifted call (e.g. a `{{config.*}}` connection that
   *  changed while paused) re-raises a fresh ask (fail closed). Optional on
   *  the type for legacy / bare pauses + the simple-form gate (no
   *  operation / connection axis, stays position-bound); the real catalog
   *  pause path always sets it. */
  approved_target?: PreflightApprovedTarget;
  /** D-211 — presentation/action metadata used by boot-time ask recovery. */
  preflight_context?: PreflightCheckpointContext;
  /** Snapshot of the `step.*` namespace (`NamespaceStores['step']`) at
   *  the moment the gate fired — step id → that step's output. The run
   *  state a fresh execution re-seeds from. `{}` when the gate fires
   *  before any step has produced output. */
  step_state: Record<string, unknown>;
  /** Engine phase and completed watcher outputs; absent on legacy sequential
   * checkpoints. A resumed watcher must still qualify before prefetch. */
  execution_phase?: 'trigger' | 'prefetch' | 'sequential';
  trigger_state?: Record<string, unknown>;
  /** Completed parallel prefetches; a hold may leave several others pending. */
  prefetch_completed?: string[];
  /** Present only when the gate fired during a foreach iteration. */
  foreach_progress?: ForeachCheckpointProgress;
  /** Previous operation receipt when this checkpoint starts a later approval
   * segment in the same foreach step. This lets boot recovery recreate the
   * new receipt without renewing the already-dispatched segment. */
  gated_action_predecessor_ref?: string;
  /** § 7 follow-on (pii-ledger-in-checkpoint) — the run's serialized
   *  `PiiLedgerStore` at the moment the gate fired. Present ONLY when the
   *  run had minted pii-protect ledgers (authored or auto-synthesized
   *  brackets); absent for the ~all runs that never alias. Resume hydrates
   *  a store from it (engine-internal — the host threads the data through
   *  `resume_from`, the engine mints + owns + disposes the hydrated store
   *  exactly as a fresh one), so post-gate `pii-restore` steps and the
   *  run-end `restoreAll` safety net return REAL values instead of passing
   *  aliases through. Persistence: plaintext under the storage layer's
   *  encryption-at-rest, like `step_state`; never `vault` material. Value
   *  provenance is step outputs (already raw in `step_state`) or config /
   *  context refs (already raw on the paused anchor's snapshots) — see the
   *  `PiiLedgerStoreSnapshot` doc for the precise claim and the retention
   *  note it raises. */
  pii_ledgers?: PiiLedgerStoreSnapshot;
  /** D-173 N.5 — editable args at the approval gate. Absent on a plain
   *  preflight gate; present ONLY when the admin-only
   *  `reception.inbox.approve` rpc approved-with-edits and wrote the
   *  user's edits here BEFORE triggering the normal resume. The engine
   *  resume (`executeRecipe(resumeFrom)`) shallow-merges these over the
   *  GATED STEP's authored/prefilled args before dispatch — and ONLY the
   *  gated step's; every other step is untouched. Absent ⇒ resume is
   *  byte-identical to D-157's binary approve/deny path (the recipe re-
   *  runs as authored, args re-resolved from the recipe definition).
   *
   *  Security boundary (D-173 N.5 MUST). This field is the ONLY conduit
   *  for an arg override, and it is writable ONLY by `reception.inbox.
   *  approve` — which validated the edits against the operation's
   *  `ArgEditSchema` allowlist (N.6) before writing them, so the engine
   *  merges them WHOLESALE (the allowlist gate is upstream, not here).
   *  The engine reads `arg_overrides` exclusively off the consumed
   *  checkpoint it is resuming, NEVER off caller / channel / context
   *  input — no non-inbox path can inject overrides, so D-157's op-
   *  identity drift guard stays at full strength on every un-edited path.
   *  When present, `approved_target` is (re)computed from the MERGED args
   *  at approve time (N.5 §3) — sound precisely because the same admin
   *  approve action authored the edits; it is NOT a general approval-
   *  bypass primitive. */
  arg_overrides?: Record<string, unknown>;
  /** D-182 §8 — the recipe-LESS raw-op door hold (see {@link RawOpCheckpoint}).
   *  Present ⇒ this is a raw-op checkpoint: `recipe_id` / `gated_step_id` are
   *  absent and the resume re-dispatches the frozen op through the catalog
   *  Gateway directly (no `executeRecipe`). Absent ⇒ the recipe-bound
   *  checkpoint, byte-identical to every pre-D-182 path. The two are mutually
   *  exclusive — the guard rejects a row that mixes them. */
  raw_op?: RawOpCheckpoint;
  /** Host-written pointer for a hold inside a reviewed future execution.
   * It supplies no approval: the resumer must reacquire the repository's
   * exact checkpoint and worker fence before entering this run. */
  preapproval_execution_ref?: string;
  /** A parent engine waiting for its actual child. Only the child's ordinary
   * owner/peer decision is actionable; the parent resumes from its result. */
  preapproval_nested_wait?: { child_run_id: string };
  /** Exact host-issued qualification poll, before any reviewed run is claimed. */
  preapproval_candidate_ref?: string;
  /** Ordinary automatic poll captured before any owner acceptance. Its
   * qualification must still match this target revision and sequence. */
  auto_run_qualification?: {
    recipe_id: string; incarnation: string; revision: number; qualifying_sequence: number;
  };
  /** The actual host entry tool, retained across a hold. This is provenance,
   * never a grant supplied by a recipe or by a resume request. */
  entry_tool_name?: string;
  /** D-202 Slice 1b — the QUALITY-relevance marker, captured at pause off the
   *  commit Gateway's `quality_not_delegated` three-conjunct verdict (threaded
   *  through `PreflightRequiredSignal` → `awaiting_approval`). `true` iff the
   *  gate raised this ask because authorization ADMITTED and only the missing
   *  quality delegation held the send — the asks whose owner answer is the
   *  reject-driven quality learner's signal. The answer-path resumer reads it
   *  and, when `true`, `append`s one `QualityDelegationSignal` (approve →
   *  `quality_good`, reject → `quality_bad`) keyed on this checkpoint's identity.
   *  Absent/`false` on every non-quality ask ⇒ no signal — behaviour-preserving.
   *  Never load-bearing for resume: a tampered/absent value only affects whether
   *  a best-effort learner signal is recorded, never what dispatches. Spec:
   *  D-202 §3 (S4). */
  quality_relevant?: boolean;
  /** Checkpoint mint time — unix epoch ms. The ordering key for
   *  `CheckpointStore.list` and the cursor for D-157's optional,
   *  generous staleness guard (N.8 SHOULD — default measured in days). */
  created_at: number;
}

/** D-182 §8 — structural predicate for the {@link RawOpCheckpoint} block.
 *  Narrows untyped JSON read back from the checkpoint store: the three op
 *  identity fields + `risk_tier` are non-empty strings, `connection_name` is a
 *  string (possibly `''`), `op_args` / `execution_source` are plain non-array
 *  objects, and the three optional strings (`arg_shape_hash` /
 *  `canonical_payload_hash` / `correlation_id`) + the optional
 *  `contract_snapshot` object are checked only when present. Structural only —
 *  the full `ExecutionSource` / `ContractSnapshot` discriminant validity is the
 *  resume path's concern (a malformed source re-dispatches and fails closed at
 *  the Gateway), not a shape constraint here. */
const isRawOpCheckpoint = (value: unknown): boolean => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const nonEmpty = (x: unknown): x is string =>
    typeof x === 'string' && x.length > 0;
  const plainObject = (x: unknown): boolean =>
    typeof x === 'object' && x !== null && !Array.isArray(x);
  if (!nonEmpty(v.op_id)) return false;
  if (!nonEmpty(v.catalog_slug)) return false;
  if (!nonEmpty(v.operation)) return false;
  if (typeof v.connection_name !== 'string') return false;
  if (!plainObject(v.op_args)) return false;
  if (!plainObject(v.execution_source)) return false;
  if (!nonEmpty(v.risk_tier)) return false;
  for (const f of [
    'arg_shape_hash',
    'canonical_payload_hash',
    'correlation_id',
    'bound_contract_id',
  ] as const) {
    if (v[f] !== undefined && typeof v[f] !== 'string') return false;
  }
  if (v.contract_snapshot !== undefined && !plainObject(v.contract_snapshot)) {
    return false;
  }
  return true;
};

/** Structural predicate — true when `value` matches the `Checkpoint`
 *  shape. Validates the required fields with their primitive types:
 *  `checkpoint_id` / `run_id` are non-empty, `step_state` is a plain object
 *  (its contents are unconstrained — they are arbitrary step outputs),
 *  and `created_at` is a finite number. The two optional objects —
 *  `approved_target` (D-165 op-identity) and `arg_overrides` (D-173 N.5
 *  editable args) — are each narrowed to a plain non-array object when
 *  present and pass unchanged when absent.
 *
 *  D-182 §8 — the row partitions on `raw_op`: a recipe-bound checkpoint
 *  requires `recipe_id` + `gated_step_id` (and no `raw_op`); a recipe-less
 *  raw-op checkpoint requires a well-formed `raw_op` block and ABSENT
 *  `recipe_id` / `gated_step_id`.
 *
 *  Structural only — it does not enforce that `run_id` resolves to a
 *  real anchor or that `gated_step_id` names a step in the recipe;
 *  those are engine pause/resume invariants, not shape constraints. The
 *  guard's job is to narrow untyped JSON read back from the checkpoint
 *  store. */
export const isCheckpoint = (value: unknown): value is Checkpoint => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const nonEmpty = (x: unknown): x is string =>
    typeof x === 'string' && x.length > 0;

  if (!nonEmpty(v.checkpoint_id)) return false;
  if (!nonEmpty(v.run_id)) return false;
  if (v.execution_phase !== undefined && (!['trigger', 'prefetch', 'sequential'].includes(v.execution_phase as string)
    || v.raw_op !== undefined)) return false;
  if (v.trigger_state !== undefined && (!v.trigger_state || typeof v.trigger_state !== 'object'
    || Array.isArray(v.trigger_state) || v.raw_op !== undefined)) return false;
  if (v.prefetch_completed !== undefined && (!Array.isArray(v.prefetch_completed)
    || !v.prefetch_completed.every(nonEmpty) || v.execution_phase !== 'prefetch' || v.raw_op !== undefined)) return false;
  if (v.preapproval_execution_ref !== undefined
    && (!nonEmpty(v.preapproval_execution_ref) || v.raw_op !== undefined)) return false;
  if (v.preapproval_nested_wait !== undefined && (!nonEmpty(v.preapproval_execution_ref)
    || !v.preapproval_nested_wait || typeof v.preapproval_nested_wait !== 'object'
    || Array.isArray(v.preapproval_nested_wait)
    || !nonEmpty((v.preapproval_nested_wait as Record<string, unknown>).child_run_id))) return false;
  if (v.preapproval_candidate_ref !== undefined && (!nonEmpty(v.preapproval_candidate_ref)
    || v.preapproval_execution_ref !== undefined || v.raw_op !== undefined || v.execution_phase !== 'trigger')) return false;
  if (v.auto_run_qualification !== undefined) {
    const poll = v.auto_run_qualification as Record<string, unknown> | null;
    if (!poll || typeof poll !== 'object' || Array.isArray(poll) || v.execution_phase !== 'trigger'
      || v.preapproval_candidate_ref !== undefined || v.preapproval_execution_ref !== undefined || v.raw_op !== undefined
      || poll.recipe_id !== v.recipe_id || !nonEmpty(poll.incarnation)
      || !Number.isSafeInteger(poll.revision) || (poll.revision as number) < 1
      || !Number.isSafeInteger(poll.qualifying_sequence) || (poll.qualifying_sequence as number) < 0) return false;
  }
  if (v.entry_tool_name !== undefined && !nonEmpty(v.entry_tool_name)) return false;
  // D-182 §8 — partition on the `raw_op` discriminant. A raw-op checkpoint is
  // recipe-LESS: `recipe_id` / `gated_step_id` MUST be absent and the `raw_op`
  // block MUST be well-formed. A recipe-bound checkpoint MUST carry both ids
  // and no `raw_op` block. Rejecting a row that mixes them keeps the
  // recipe-less ⇔ recipe-bound partition clean both ways (mirrors the D-182
  // Inc 1 raw_op grant partition).
  if (v.raw_op !== undefined) {
    if (v.recipe_id !== undefined || v.gated_step_id !== undefined) return false;
    if (!isRawOpCheckpoint(v.raw_op)) return false;
  } else {
    if (!nonEmpty(v.recipe_id)) return false;
    if (!nonEmpty(v.gated_step_id)) return false;
  }
  if (v.recipe_source_hash !== undefined) {
    if (v.raw_op !== undefined || !nonEmpty(v.recipe_source_hash)) return false;
  }
  // `recipe_snapshot` is optional (R2 step 6 — inline-run resume); when
  // present it must be a plain object. Content integrity is the
  // resumer's hash check against the anchor, not a shape concern.
  if (v.recipe_snapshot !== undefined) {
    if (
      typeof v.recipe_snapshot !== 'object'
      || v.recipe_snapshot === null
      || Array.isArray(v.recipe_snapshot)
    ) {
      return false;
    }
  }
  // `predecessor_commit_id` is optional (R2 step 6 — a paused saga
  // compensation run); when present it must be a non-empty string.
  if (v.predecessor_commit_id !== undefined && !nonEmpty(v.predecessor_commit_id)) {
    return false;
  }
  if (v.gated_action_predecessor_ref !== undefined
    && !nonEmpty(v.gated_action_predecessor_ref)) return false;
  // `approved_target` is optional; when present it must be a plain object
  // whose present identity fields are strings (the catalog gate sets the
  // full triple, the simple-form gate only `ingredient_slug`; absent fields
  // are allowed). This is the documented JSON-narrowing point for a
  // security-boundary object — reject a non-string present field rather than
  // letting it through (the catalog match fails closed on a non-string
  // anyway, but the guard is the contract — codex review MED).
  if (v.approved_target !== undefined) {
    if (
      typeof v.approved_target !== 'object'
      || v.approved_target === null
      || Array.isArray(v.approved_target)
    ) {
      return false;
    }
    const t = v.approved_target as Record<string, unknown>;
    for (const f of ['ingredient_slug', 'operation_id', 'connection_name'] as const) {
      if (t[f] !== undefined && typeof t[f] !== 'string') return false;
    }
  }
  if (v.preflight_context !== undefined) {
    if (
      typeof v.preflight_context !== 'object'
      || v.preflight_context === null
      || Array.isArray(v.preflight_context)
    ) return false;
    const c = v.preflight_context as Record<string, unknown>;
    // `origin_actor` rides the widened-string lane WITH `risk_tier`, not the
    // closed-union lane with `approval_clamped_from` below: a display-only
    // member must never be the reason a pending approval fails to load.
    for (const f of [
      'tool_slug', 'connection_name', 'risk_tier', 'reason', 'origin_actor',
    ] as const) {
      if (c[f] !== undefined && typeof c[f] !== 'string') return false;
    }
    if (c.gated_action_settlement_mode !== undefined
      && c.gated_action_settlement_mode !== 'returned_result'
      && c.gated_action_settlement_mode !== 'durable_handoff') return false;
    if (c.egress_bound !== undefined) {
      if (typeof c.egress_bound !== 'object'
        || c.egress_bound === null
        || Array.isArray(c.egress_bound)) return false;
      const bound = c.egress_bound as Record<string, unknown>;
      if (!Number.isInteger(bound.requests)
        || (bound.requests as number) < 1
        || !Number.isFinite(bound.total_bytes)
        || (bound.total_bytes as number) < 0) return false;
    }
    if (
      c.approval_clamped_from !== undefined
      && !isOperationApproval(c.approval_clamped_from)
    ) return false;
    if (c.authorization_provenance !== undefined) {
      if (
        typeof c.authorization_provenance !== 'object'
        || c.authorization_provenance === null
        || Array.isArray(c.authorization_provenance)
      ) return false;
      const p = c.authorization_provenance as Record<string, unknown>;
      if (!isOperationApproval(p.pre_lift_approval)) return false;
      if (
        p.lift_reason !== undefined
        && p.lift_reason !== 'review_send'
        && p.lift_reason !== 'review_commitment'
        && p.lift_reason !== 'quality'
      ) return false;
    }
    if (c.owner_override_offer !== undefined) {
      if (
        typeof c.owner_override_offer !== 'object'
        || c.owner_override_offer === null
        || Array.isArray(c.owner_override_offer)
      ) return false;
      const o = c.owner_override_offer as Record<string, unknown>;
      if (typeof o.ingredient_id !== 'string' || o.ingredient_id.length === 0) return false;
      if (typeof o.operation_id !== 'string' || o.operation_id.length === 0) return false;
      if (!isOperationSpecHash(o.op_hash)) return false;
      if (!(
        (o.kind === 'never_ask' && o.approval === 'never')
        || (o.kind === 'relax_to_ask' && o.approval === 'ask')
      )) return false;
    }
  }
  if (
    !v.step_state
    || typeof v.step_state !== 'object'
    || Array.isArray(v.step_state)
  ) {
    return false;
  }
  if (v.foreach_progress !== undefined) {
    if (v.raw_op !== undefined
      || typeof v.foreach_progress !== 'object'
      || v.foreach_progress === null
      || Array.isArray(v.foreach_progress)) return false;
    const progress = v.foreach_progress as Record<string, unknown>;
    if (!nonEmpty(progress.step_id)
      || progress.step_id !== v.gated_step_id
      || !Number.isInteger(progress.next_index)
      || (progress.next_index as number) < 0
      || !Number.isInteger(progress.source_length)
      || (progress.source_length as number) < 1
      || typeof progress.source_hash !== 'string'
      || !/^[0-9a-f]{64}$/.test(progress.source_hash)
      || (progress.next_index as number) >= (progress.source_length as number)
      || !Array.isArray(progress.results)
      || progress.results.length !== progress.next_index) return false;
    for (const entry of progress.results) {
      if (entry === null
        || typeof entry !== 'object'
        || Array.isArray(entry)
        || typeof (entry as { ok?: unknown }).ok !== 'boolean') return false;
      if ((entry as { skipped?: unknown }).skipped !== undefined
        && typeof (entry as { skipped?: unknown }).skipped !== 'boolean') return false;
    }
  }
  if (v.gated_action_predecessor_ref !== undefined
    && v.foreach_progress === undefined) return false;
  // § 7 follow-on — `pii_ledgers` is optional; when present it must be a
  // plain object (the serialized run ledger store). Contents stay
  // unconstrained at the guard — the hydrating store (`@recued/transforms`)
  // tolerates missing/odd member shapes by construction, and a checkpoint
  // row is engine-written, not wire input.
  if (v.pii_ledgers !== undefined) {
    if (
      typeof v.pii_ledgers !== 'object'
      || v.pii_ledgers === null
      || Array.isArray(v.pii_ledgers)
    ) {
      return false;
    }
  }
  // D-173 N.5 — `arg_overrides` is optional; when present it must be a
  // plain object (the gated step's edited args, keyed by arg path). This
  // is the documented JSON-narrowing point for the editable-args
  // boundary object — reject a non-object (string / array / null) rather
  // than letting it through to the resume merge, which shallow-merges
  // wholesale and would otherwise spread a primitive / array's enumerable
  // keys over the gated step's authored args. Absent/undefined passes
  // unchanged (the plain binary-gate checkpoint).
  if (v.arg_overrides !== undefined) {
    if (
      typeof v.arg_overrides !== 'object'
      || v.arg_overrides === null
      || Array.isArray(v.arg_overrides)
    ) {
      return false;
    }
  }
  if (typeof v.created_at !== 'number' || !Number.isFinite(v.created_at)) {
    return false;
  }
  return true;
};
