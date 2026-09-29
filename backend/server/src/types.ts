/** Recued server types — minimal surface post-trim.
 *
 *  The server is an execution plane only: it runs recipes handed to it
 *  by the paired extension (control plane) or by local MCP clients.
 *  The sync-relay types (vault/installed/instances/schedules/commands/
 *  executions) that used to live here are gone — that responsibility
 *  moved to the cloud Worker.
 */

import type {
  Condition,
  ContainerPickDetail,
  CreatePlanDetail,
  ForeachCheckpointProgress,
  PiiLedgerStoreSnapshot,
  PreflightApprovedTarget,
  RunControlTermination,
  RunDegradation,
  RecipeInvocation,
  ResolvedOutputSection,
} from '@recued/contracts';
import type { ExchangeAcknowledgement } from '@recued/engine';

/** A realm identifier — a bearer token the client presents on every
 *  authenticated request. After pairing, the server issues one realm
 *  token (the pairing manager's persistent token) and the extension
 *  sends it on every POST /execute. */
export type RealmId = string;

/** Wire envelope the dispatcher + HTTP serializer use. Discriminated
 *  result with either a successful body or an error. The HTTP layer
 *  maps `status` to the response code; the WS dispatcher converts
 *  thrown `RpcError`s from handlers into this shape.
 *
 *  Note: handlers themselves no longer return `HandlerResult`
 *  directly — they return the bare response type and throw
 *  `RpcError` on failure. The envelope lives here so the transport
 *  layer has a single place to serialize both sides. */
export type HandlerResult<T> =
  | { ok: true; status: number; body: T }
  | {
      ok: false;
      status: number;
      error: {
        code: string;
        message: string;
        /** Structured per-code metadata. Mirrors `RpcError.details`;
         *  carried verbatim to the wire so the client can switch on
         *  typed fields instead of parsing `message`. Codex W3.FU P2
         *  fold landed this slot. */
        details?: Readonly<Record<string, unknown>>;
      };
    };

// ────────────────────────────────────────────────────────────────
// Recipe execution (POST /execute)
// ────────────────────────────────────────────────────────────────

/** POST /execute request body. Either recipe_id (lookup) or recipe (inline). */
export interface ExecuteRequest {
  /** Lookup installed/bundled recipe by id. */
  recipe_id?: string;
  /** Inline recipe definition — takes priority over recipe_id. */
  recipe?: unknown;
  /** Vault overrides for this execution (plaintext key-value). Merged on
   *  top of server vault (populated via pair-sync from extension). */
  vault?: Record<string, unknown>;
  /** Config overrides (recipe variables). */
  config?: Record<string, unknown>;
  /** D-222 — host control-plane identity for a submit originating in one
   *  resolved output filter. Never projected into recipe namespaces. */
  invocation?: RecipeInvocation;
  /** D-179 P1 — standing dish to run as. The dish's `config_overlay`
   *  merges OVER `config` at dispatch (dish → install → defaults) and
   *  the run's audit row carries the dish for attribution. Absent ⇒
   *  an ephemeral dish id is derived from the run id (manual-run
   *  attribution only; nothing persists). */
  dish_id?: string;
  /** Context namespace values (entity_id, page_url, etc.). */
  context?: Record<string, unknown>;
  /** How the execution was triggered (manual, scheduled, backfill, server_command). */
  trigger_source?: string;
  /** D-153 P2.C — typed `(channel × actor)` source the policy gate
   *  evaluates against. Upstream dispatchers (scheduler / MCP server /
   *  webhook receiver / etc.) construct the channel-shaped variant with
   *  the right tagged fields. The execute-handler wires the gate for
   *  channels whose P2.C slice has landed (`schedule` + `reactive` +
   *  `mcp` at present); channels still in the pre-P2.C path leave this
   *  field absent and flow through unchanged. */
  execution_source?: import('@recued/contracts').ExecutionSource;
  /** D-153 P2.C — `ContractSnapshot` resolved at dispatch time for a
   *  source carrying a `contract_id` (`contracted_user`, or a self-
   *  restricted `user_self` — D-161 N.4). Required when
   *  `execution_source` carries a `contract_id` per spec line 429;
   *  system-actor channels (`schedule` / `reactive` / `housekeeping`)
   *  leave this absent; a webhook dispatch carries it exactly when its
   *  trigger row is door-stamped (D-209 #1 W3 — the webhook runner
   *  resolves it via `buildWebhookContractSnapshot`). Each producer resolves
   *  the live authority available to its door (for example, MCP joins the
   *  manifest registry with inbound-token grants), then content-versions the
   *  resulting authority through the shared snapshot finalizer. */
  contract_snapshot?: import('@recued/contracts').ContractSnapshot;
  /** Instance that executed this recipe. Set by the server for attribution. */
  instance_id?: string;
  /** Smart Backfill metadata — Phase 5. Set by the scheduler when
   *  this execution is a catch-up fire so the audit row carries the
   *  diagnostic count + the prior last_run_at. Other triggers leave
   *  it undefined. */
  backfill?: {
    missed_cycles: number | 'unknown';
    last_run_at_before: number;
  };
  /** D-115 — reactive recipe `process_id`. Set by the server's
   *  auto-run scheduler so the audit row groups under the stable
   *  UUID issued for this install. Other triggers leave it undefined. */
  process_id?: string;
  /** D-160 P3 — the I-7 loop-bound hop token (D-145 #22). The
   *  dispatch-tree depth this run sits at: `0` (the default) for a
   *  top-level run; a re-entrant fire — a `messenger` post that
   *  re-enters as a trigger — carries `nextDispatchDepth(parent)`. The
   *  execute-handler threads it onto the run's `CommitRunIdentity`,
   *  where the Gateway refuses dispatch once it passes
   *  `MAX_DISPATCH_DEPTH`. Absent on the pre-D-160-O-5 dispatch paths
   *  (the channels are not yet wired to `handleExecute`); those flow
   *  through at depth 0. */
  dispatch_depth?: number;
}

/** D-157 server-wiring — `handleExecute` internal-only overrides.
 *  Only `PreflightResumer.resumeRun` constructs these; wire-facing
 *  dispatchers (rpc / chat / scheduler / mcp) MUST NOT pass them. The
 *  fields live on a separate parameter so the public `ExecuteRequest`
 *  type cannot carry a `run_id` override that smuggles past a wire
 *  builder — a misbehaving dispatcher cannot accidentally overwrite an
 *  unrelated run's audit row by setting these fields. */
export interface InternalExecuteOverrides {
  /** D-261 opaque host-issued run handle. The private runtime WeakMap must
   * recognize it; a serialized future/grant id carries no execution authority. */
  preapproval_run?: object;
  /** Host-issued, unclaimed automatic-run poll. It confers no approval until
   * the ordinary trigger phase qualifies and the runtime claims this run. */
  preapproval_candidate?: object;
  /** Ordinary automatic polls advance their durable qualifying sequence at
   * the same phase boundary. Only the owned driver installs this callback. */
  after_auto_run_qualification?: () => void;
  auto_run_qualification?: import('@recued/contracts').Checkpoint['auto_run_qualification'];
  /** Authenticated external tool entry, never accepted from ExecuteRequest. */
  entry_tool_name?: string;
  /** D-221 watcher causality minted only by the durable Records outbox
   * runner. It never appears on ExecuteRequest, so recipe/client args cannot
   * reset a root, depth, or watcher identity. */
  records_event?: {
    root_event_id: string;
    causal_depth: number;
    watcher_digest: string;
  };
  /** Override the minted `run_id`. The resumer uses this to re-issue
   *  the paused anchor's `run_id` so the resumed run transitions the
   *  same execution-request anchor in place. */
  run_id?: string;
  /** D-315 §6.4 — told the run's id as soon as it exists (minted, or the
   *  `run_id` override), before anything can fail. The event-trigger runtime
   *  uses it so the dispatcher's `trigger_fired` entry can name the run for
   *  EVERY outcome — a failed or held run included, not only a clean one.
   *  ⚠ Not a way to CHOOSE the id: passing `run_id` means "resume". */
  onRunMinted?: (run_id: string) => void;
  /** Stable receipt for the checkpointed gated STEP being resumed. It is not
   * the run id (a run can gate more than once) and not an ask id (one ask can
   * cover many steps and be re-rendered). Populated only by the host resumer. */
  gated_action_ref?: string;
  /** R2 step 6 (write-saga) — set ONLY by the saga compensation
   *  dispatcher (`saga-server-wiring.ts`): this run COMPENSATES the
   *  named commit, and every commit it dispatches carries the link as
   *  `predecessor_commit_id` (D-153 § compensating commits — the pair
   *  filter behind `isCompensatingCommit`). Internal-only for the same
   *  reason as `run_id`: a wire dispatcher must not be able to stamp
   *  false compensation provenance onto arbitrary runs. */
  predecessor_commit_id?: string;
  /** D-192 6c.2c — set ONLY by the create-plan re-run wiring: the id of the STEP
   *  whose work-entity vendor create the user approved via the create-plan confirm
   *  (the step that raised `create_plan_required`; captured from the RecipeError's
   *  `source.step_id`). Threaded onto `ExecutionContext.work_entity_write_
   *  preadmitted_step_id` → `buildStepMeta` stamps `StepMeta.work_entity_write_
   *  preadmitted` on THAT step only → the kernel create adapter → the vendor
   *  create's `preflight_admitted`, so the write executor's standalone gated spine
   *  admits past the op's `'ask'` verdict (it has no pause path) — for the confirmed
   *  write alone, never another `ask`-create in the same replayed recipe. Internal-
   *  only for the same reason as `run_id`: a wire dispatcher must never pre-admit a
   *  vendor write. `ask`→admit only — never a `'deny'` bypass. */
  work_entity_write_preadmitted_step_id?: string;
  /** The consumed checkpoint's resume payload. The handler seeds
   *  `stores.step` with `step_state` BEFORE dispatch, then enters the
   *  engine's resume mode at `gated_step_id`. */
  resume_from?: {
    gated_step_id: string;
    step_state: Record<string, unknown>;
    execution_phase?: 'trigger' | 'prefetch' | 'sequential';
    trigger_state?: Record<string, unknown>;
    prefetch_completed?: string[];
    foreach_progress?: ForeachCheckpointProgress;
    /** Host-recorded amplification bound for the approved dispatch. A
     * resumed foreach may spend this authority on only its current item; the
     * engine clears admission before advancing to another item. */
    egress_bound?: { readonly requests: number; readonly total_bytes: number };
    /** D-165 follow-on (op-identity binding) — the consumed checkpoint's
     *  `approved_target`, threaded onto `ExecutionContext.resumeFrom` so the
     *  catalog gate can re-verify the resumed call against the approved
     *  identity. Absent on a checkpoint that captured no identity. */
    approved_target?: PreflightApprovedTarget;
    /** D-173 N.5 — the consumed checkpoint's `arg_overrides` (the
     *  admin-only `reception.inbox.approve` rpc approved-with-edits).
     *  Threaded verbatim onto `ExecutionContext.resumeFrom.arg_overrides`
     *  so the engine shallow-merges them over the GATED STEP's authored
     *  args before dispatch. Sourced ONLY from `checkpoint.arg_overrides`
     *  (see `preflight-resumer.ts` → `buildResumeInputs`) — this internal-
     *  only override channel is the boundary that keeps overrides off any
     *  caller / channel / wire path (N.5 MUST). Absent on a plain
     *  binary-gate checkpoint ⇒ resume is byte-identical to today. */
    arg_overrides?: Record<string, unknown>;
    /** D-177 P3 — the `allow_session` answer's mint instruction (the
     *  bounds the preflight ask offered). Threaded onto
     *  `ExecutionContext.resumeFrom.session_grant` so the engine marks the
     *  resumed gated step and the commit Gateway mints a session grant from
     *  that dispatch's own envelope (the D9 merged-args basis). Sourced
     *  ONLY from the preflight answer context (`PreflightResumer.resumeRun`
     *  populates it exactly when the recorded answer was `allow_session`) —
     *  internal-only for the same reason as the siblings: a wire dispatcher
     *  must not be able to mint itself a standing loosening of the gate.
     *  Absent ⇒ resume is byte-identical to the plain approve path.
     *  D-177 P5b — `grant_mode: 'open'` selects the N.11 provenance-pinned
     *  mint; threaded opaquely (the Gateway validates the mode). */
    session_grant?: {
      ttl_ms: number;
      max_uses: number;
      risk_tier: string;
      grant_mode?: string;
    };
    /** D-177 P5a (N.10) — the batched approve's member-claim instruction
     *  for this held run. Threaded onto
     *  `ExecutionContext.resumeFrom.batch_claim` so the engine marks the
     *  resumed gated step and the commit Gateway atomically claims the
     *  named `grant_mode: 'batch'` member at the proceed point (the claim
     *  IS the consumption — N.4; a member an agent replay already claimed
     *  re-holds, so the approved budget is never exceeded). Sourced ONLY
     *  from the batch answer flow (`batch-approval.ts` populates the
     *  resume context per member) — internal-only for the same reason as
     *  the siblings. Absent ⇒ resume is byte-identical to the plain
     *  approve path. */
    batch_claim?: { contract_id: string; member_id: string };
    /** § 7 follow-on (pii-ledger-in-checkpoint) — the consumed
     *  `Checkpoint.pii_ledgers` snapshot, threaded verbatim onto
     *  `ExecutionContext.resumeFrom.pii_ledgers` so the engine hydrates the
     *  resumed run's `PiiLedgerStore` and post-gate `pii-restore` steps
     *  return real values. Sourced ONLY from the consumed checkpoint (see
     *  `preflight-resumer.ts` → `buildResumeInputs`) — internal-only like
     *  its siblings. Absent ⇒ a plain fresh store (legacy checkpoints /
     *  runs that never aliased). */
    pii_ledgers?: PiiLedgerStoreSnapshot;
  };
  /** D-232 — the cycle guard's ancestor set for a NESTED run: every recipe
   *  already on this call's stack, the callee included (the gateway widens it
   *  before handing it to the invoker). Threaded onto
   *  `ExecutionContext.heldRecipes` so the guard composes down the dispatch
   *  tree instead of protecting the first hop only.
   *
   *  ⛔ Internal-only for a sharper reason than its siblings: this set is the
   *  guard's ENTIRE memory. A wire dispatcher able to supply it could hand in
   *  an empty stack and re-enter a recipe already running — A → B → A, admitted
   *  because the caller said there was no ancestry. Only `handleExecute`'s own
   *  `localRecipeInvoker` populates it. */
  held_recipes?: ReadonlySet<string>;
  /** D-232 § 20.9 — the exchange this run belongs to, for a run the host
   *  dispatched ON BEHALF of one: the fire's own `run-ingredient` dispatch,
   *  which carries the answer and is therefore the run whose outcome "did it
   *  reach the peer" is actually asking about.
   *
   *  ⛔ Internal-only, like its siblings, and here the reason is that the ref is
   *  an ADDRESS: a wire dispatcher able to set it could file its run under
   *  somebody else's exchange, and the query surface would then report a
   *  stranger's run as part of your conversation. Only `handleExecute`'s own
   *  `exchangeFireHandler` populates it. */
  exchange_ref?: string;
  /** D-232 § 20.19 — this nested run IS a granted recipe's work: the host
   *  dispatched it on behalf of a run whose recipe the door was granted, so the
   *  callee's steps inherit that coverage the way they already inherit the
   *  contract. Without it the rule stops at the first hop — the fire's own
   *  `run-ingredient` carrier run holds no grant of its own and is refused for
   *  a grant its declaring run holds.
   *
   *  ⛔ Internal-only, and here the reason is the sharpest of the three: this
   *  flag IS an authorization. A wire dispatcher able to set it would hand
   *  itself the coverage of a recipe it was never granted, turning the whole
   *  gate off with one boolean. Only `handleExecute`'s own `localRecipeInvoker`
   *  and `exchangeFireHandler` populate it, and only from a coverage they
   *  resolved for the parent run — never from anything on the request.
   *
   *  ⛔ THE NAME, NOT A BOOLEAN. An approval can outlive the grant that
   *  justified it, and the approval-resume authority has to re-ask "does this
   *  door STILL hold that grant" before the approved effect dispatches. A
   *  yes/no cannot answer it. Persisted onto the run anchor as
   *  `AuditEntry.granted_by_recipe` so the answer survives the pause. */
  granted_by_recipe?: string;
}

/** Internal-only metadata key for the durable audit row written by
 * `handleExecute`. A symbol keeps this host-owned address out of JSON / model
 * projections while allowing the in-process Chat dispatcher to correlate an
 * execution receipt with the exact Logs run. It is absent when no audit anchor
 * was durably written. */
export const EXECUTE_RESPONSE_AUDIT_RUN_ID: unique symbol = Symbol(
  'recued.execute_response_audit_run_id',
);

/** Internal-only metadata key for the standing dish that was actually
 * dispatched. Ephemeral dish ids are deliberately never stamped: they are a
 * pure function of `run_id`, resolve to no store row, and would look like an
 * owner-manageable handle on the canonical chat log. */
export const EXECUTE_RESPONSE_STANDING_DISH_ID: unique symbol = Symbol(
  'recued.execute_response_standing_dish_id',
);

/** POST /execute response on success. Mirrors engine ExecutionResult.
 *  Render blocks carry an index signature for block-specific extras
 *  (label, source, etc.) — same shape as engine/src/types.ts. */
export interface ExecuteResponse {
  /** Host-internal, non-serializable audit address. See
   * `stampExecuteResponseAuditRun`. */
  readonly [EXECUTE_RESPONSE_AUDIT_RUN_ID]?: string;
  /** Host-internal, non-serializable standing-dish address. */
  readonly [EXECUTE_RESPONSE_STANDING_DISH_ID]?: string;
  recipe_id: string;
  recipe_hash: string;
  success: boolean;
  output: {
    render: ResolvedOutputSection[];
    sidebar: ResolvedOutputSection[];
  };
  /** ⚠ `foreach` WAS ALREADY BEING COPIED ONTO EVERY RESPONSE AND WAS MISSING
   *  FROM THIS TYPE, so no typed consumer could read it. The enumerating copier
   *  in `execute-handler.ts` emits `...(s.foreach === undefined ? {} : { foreach: s.foreach })`;
   *  the declaration simply never caught up. D-268 needs it to ask
   *  `deriveRunYield` whether a run refused every item it attempted — a run that
   *  reports `success: true` while producing nothing. */
  steps: {
    id: string; type: string; skipped: boolean; duration_ms: number; error: unknown;
    foreach?: { items: number; failed: number };
    /** On the step whose `stop_when` ended the run. */
    stopped?: true;
  }[];
  errors: unknown[];
  duration_ms: number;
  /** Post-execution observability degradation. The run's side effects
   *  already happened; callers should surface that recording is
   *  incomplete without marking the recipe execution itself failed. */
  degraded?: RunDegradation[];
  /** D-115 Phase 5 — reactive trigger gate short-circuited the run.
   *  Silent-skip: no audit entry, scheduler counter unchanged. Only
   *  ever set on `trigger_source: 'auto_run'` runs. */
  trigger_skipped?: boolean;
  /** A step's `stop_when` ended the run early, as a success: the steps after
   *  it did not run. Unlike `trigger_skipped`, the steps up to it DID run, and
   *  their output is the answer. */
  stopped?: { step_id: string; condition: string | Condition };
  /** D-115 Phase 5 — dynamic-interval hint (epoch ms) the recipe's
   *  `next_run_at` step computed. Scheduler's `markFinished` uses it
   *  when `auto_run.dynamic` is true. */
  next_run_at?: number;
  /** D-157 — the run is durably PAUSED at the preflight gate, awaiting the
   *  user's approval (a `checkpoint_id` + `notification.ask` were minted).
   *  Distinct from a terminal failure: `success` is `false` but the run is
   *  queued, not failed. Set only when the pause is durable (a checkpoint
   *  write succeeded); a pause that downgraded to terminal failure leaves
   *  this unset. Lets callers (esp. the chat tool-loop) tell the model the
   *  action is awaiting approval instead of mistaking the bare `success:
   *  false` for a silent failure and retrying. */
  awaiting_approval?: boolean;
  /** D-display-mode P4 — whether this run was audit-exempt (no anchor written).
   *
   *  ⚠ PAIRED WITH `ServerExecuteResponse.audit_exempt` in contracts, which is
   *  the WIRE shape this one mirrors. The two are twins by construction (see
   *  this interface's own header) and nothing enforces the pairing, so a field
   *  added to one and not the other is invisible until a client reads
   *  `undefined` forever. The full reasoning — why a client needs it, and why it
   *  must never re-derive it — lives on the contracts side. */
  audit_exempt?: boolean;
  /** Durable operation-scoped receipt for the checkpointed gated step. */
  action_ref?: string;
  /** D-234 § 234.4 — the run is durably PAUSED waiting on a PEER'S answer. Same
   *  shape of fact as `awaiting_approval` above and the same third state:
   *  `success` is `false`, the run is queued, not failed.
   *
   *  ⛔⛔ A SEPARATE FIELD, NOT A WIDENING OF `awaiting_approval`, FOR THE REASON
   *  `awaiting_peer` IS A SEPARATE `commit_status` (`commits.ts`
   *  `RUN_ANCHOR_STATUSES`): the owner cannot ANSWER this hold, only cancel it or
   *  keep waiting. A caller that read it as `awaiting_approval` would offer an
   *  approve affordance for something no approval resolves; a caller that does
   *  not know this field does nothing at all, which is the harmless direction.
   *
   *  ⇒ So the question every reader of the pair has to answer is the one
   *  `isHeldRunAnchorStatus` poses one layer down: does this site mean "the run is
   *  HELD" (read BOTH — a visitor page, a durability claim, a resumer) or "held
   *  for MY OWNER'S APPROVAL specifically" (read `awaiting_approval` alone — an
   *  approvals queue, an approve/deny button)?
   *
   *  ⚠ MUTUALLY EXCLUSIVE WITH `awaiting_approval` BY CONSTRUCTION, matching the
   *  anchor rule that an approval pause wins when both are somehow set: the
   *  response carries whichever the host wrote the checkpoint for, never both. */
  awaiting_peer?: boolean;
  /** D-232 § 19.3 — the receipt for an exchange this run FIRED: the ref the
   *  caller asks about later, and where the rest of the answer arrives.
   *
   *  ⛔ THIS IS THE EXCHANGE'S ONLY JUSTIFICATION REACHING THE CALLER. A sender
   *  expects nothing back — that is the post office — and the one thing the
   *  substrate adds over a letter is that you can ask what happened to it. The
   *  ref is the handle for asking. Until this field existed the engine derived
   *  the receipt (`acknowledgementFor`, so no recipe could forget it) and then
   *  nothing carried it: every answer went out and every caller was left with
   *  nothing to ask about.
   *
   *  Passes through `projectRunResultForAgent` as its own named third state, so
   *  an agent is TOLD the answer was accepted rather than handed an empty
   *  `output.render` beside a flag — the shape that once made a model report an
   *  unchecked recipe's empty result as "you have none". */
  exchange_ack?: ExchangeAcknowledgement;
  /** D-232 § 30 — what the PEER reported when this run's fire reached them.
   *
   *  ⚠ NOT the sibling above renamed. `exchange_ack` is OUR receipt (did our
   *  letter go — on this path, yes) and this is THEIRS (did their reply go).
   *  Both are true at once, about different questions, which is exactly why
   *  the § 29 defect one layer down was possible: one ack read as an answer to
   *  both. Absent unless a correspondent actually sent a receipt. */
  exchange_peer_ack?: ExchangeAcknowledgement;
  /** D-181 § 9 — the run was terminated by the OWNER, not by a
   *  recipe-internal failure: `'killed'` = an `execution.kill` aborted a
   *  running op; `'cancelled_before_dispatch'` = an `execution.cancel`
   *  dropped a queued call before it dispatched. `success` is `false`
   *  either way, but this distinguishes a deliberate user cancellation
   *  from an ordinary failure so the agent-facing projection
   *  (`run-result-agent-projection.ts`) renders a "the user cancelled
   *  this — resolve with them, do NOT retry" tool result instead of a
   *  retryable error. Sourced from the in-flight registry's control
   *  termination (D-181 slice 4); unset on success / pause / ordinary
   *  failure. */
  run_terminated?: RunControlTermination;
  /** D-192 Slice 6b — a work-entity create in this run could not proceed because
   *  its vendor container dependency (Linear `team`, an Asana `workspace`) was
   *  AMBIGUOUS. Like `awaiting_approval`, `success` is `false` but this is NOT a
   *  silent failure: a D-158 pick ask was raised (its `ask_id` when the raise
   *  succeeded) and, once the user chooses, a fresh run re-does the create off
   *  the stored selection. Lets the chat tool-loop tell the model the create is
   *  queued behind a container choice instead of retrying the bare failure.
   *  Carries the choice set so a UI can render its own picker. */
  container_pick_required?: ContainerPickDetail & {
    ask_id?: string;
    /** S4 — computed at the `handleExecute` catch site: whether the ACTING
     *  contract may create a NEW container of this ref (its resolved `create_op`
     *  granted under the `admitVendorWrite` allowlist). Drives the chat
     *  projection's permission-branched copy — an actionable create path
     *  (`container_names` fast-track / a create tool) when true, or
     *  `no_new_project_permission` (pick-only) when a create op exists but this
     *  contract lacks the grant. */
    can_create_new_container?: boolean;
  };
  /** D-192 Slice 6c — a work-entity create in this run DECIDED to create a named
   *  vendor container that doesn't exist yet (a granted `create_op`), so it can't
   *  proceed until the user confirms. Like `awaiting_approval`, `success` is
   *  `false` but this is NOT a silent failure: ONE create-plan confirm was raised
   *  (its `ask_id` when the raise succeeded) enumerating the container create(s) +
   *  the pending write, and on approval a fresh run creates the container(s) then
   *  re-does the write. Carries the plan so a UI can render its own confirm. */
  create_plan_required?: CreatePlanDetail & { ask_id?: string };
  /** D-182 §10 step 8 / R1 — kernel-canonical-runnability pre-run warnings.
   *  One per `core.crm.*`/`core.acct.*` read/search op-step whose convention
   *  provider was not connected: the op returned an empty result and the recipe
   *  ran on empty data (downstream-safe), so `success` can be `true` while this
   *  discloses the degraded read. An unbound canonical WRITE fails closed before
   *  the run instead (the `connection_required` rpc error), so it never reaches
   *  here. Present only when ≥1 read warning fired. */
  runnability_warnings?: string[];
}

/** Attach a trustworthy Logs address without widening the wire response or the
 * agent-visible execution result. Non-enumerable symbol properties are omitted
 * by JSON serialization and object spread. */
export const stampExecuteResponseAuditRun = (
  response: ExecuteResponse,
  run_id: string | undefined,
): ExecuteResponse => {
  if (run_id === undefined) return response;
  Object.defineProperty(response, EXECUTE_RESPONSE_AUDIT_RUN_ID, {
    value: run_id,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return response;
};

/** Read the host-stamped durable Logs address, if this response has one. */
export const executeResponseAuditRunId = (
  response: ExecuteResponse,
): string | undefined => response[EXECUTE_RESPONSE_AUDIT_RUN_ID];

/** Attach the existing standing dish that was dispatched. Callers must pass
 * only a persisted dish id; the execute handler owns that discrimination. */
export const stampExecuteResponseStandingDish = (
  response: ExecuteResponse,
  dish_id: string | undefined,
): ExecuteResponse => {
  if (dish_id === undefined) return response;
  Object.defineProperty(response, EXECUTE_RESPONSE_STANDING_DISH_ID, {
    value: dish_id,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return response;
};

/** Read the host-stamped standing dish address, if this run used one. */
export const executeResponseStandingDishId = (
  response: ExecuteResponse,
): string | undefined => response[EXECUTE_RESPONSE_STANDING_DISH_ID];

// ────────────────────────────────────────────────────────────────
// Recipe store — pair-sync cache of recipes the extension pushed
// ────────────────────────────────────────────────────────────────

/** A recipe the server knows about. Populated via pair-sync push from
 *  the extension, not fetched directly from marketplace. */
export interface StoredRecipe {
  recipe_id: string;
  publisher_id: string;
  version: number;
  recipe_hash: string;
  recipe_json: string;
  /** Where the recipe came from, for provenance only. */
  source: 'bundled' | 'pair-sync' | 'inline';
  installed_at: number;
  /** D-145 PA10 follow-on — slug of the pack that installed this
   *  recipe, or `null` for pre-existing / manually installed rows.
   *  Drives the pack-aware uninstall transaction in
   *  `pack-uninstall-handler.ts` — uninstall drops only rows where
   *  `pack_slug === <uninstalling_slug>`, leaving pre-existing rows
   *  + rows owned by other packs untouched. */
  pack_slug: string | null;
}
