import type { PeerAskSpec } from '@recued/contracts';
import type {
  Actor,
  Condition,
  ContractSnapshot,
  ExecutionSource,
  RecipeDefinition,
  NamespaceStores,
  RecipeError,
  IngredientManifest,
  EntityFieldDeclaration,
  OpenProjection,
  OpenProjectionComputation,
  StepOptions,
  StepMeta,
  EmittedLink,
  ContextRecipe,
  ConnectionOperationProfile,
  GatewayCallAudit,
  PiiLedgerStoreSnapshot,
  PreflightApprovedTarget,
  ForeachCheckpointProgress,
  PreflightOverrideOffer,
  OperationApproval,
  AuthorizationProvenance,
  RiskTier,
  RunDegradation,
  ScanFn,
  CliMethodBinding,
  LaneGovernor,
  ExecutionLane,
  OpDurationClassifier,
  RestExecutionBinding,
  ResolvedOutputSection,
  RecordsExecutionBinding,
  RecordsExecutionCall,
  RecipeStep,
} from '@recued/contracts';
import type { ValidationIssue } from '@recued/recipes';
import type { ContextRecipeSnapshotResult } from './context-recipe.js';
import type { SharedResolvers } from './shared-prefetch.js';
import type { StepEffect } from './step-seed.js';

/** Pluggable function that executes ingredient calls (HTTP, DOM, LLM, MCP).
 *  `stepOutput` is the optional per-step output mapping that extends the
 *  ingredient manifest's default output. `stepOptions` carries cross-cutting
 *  per-call hints (e.g. cache freshness) derived from the step definition.
 *  `stepMeta` carries per-call step identity + approval policy (D-113); the
 *  engine supplies it for ingredient + prefetch steps. Middleware that
 *  doesn't consume it forwards unchanged. */
export type IngredientExecutor = (
  slug: string,
  input: Record<string, unknown>,
  stepOutput?: Record<string, string>,
  stepOptions?: StepOptions,
  stepMeta?: StepMeta,
) => Promise<unknown>;

export interface CliInvocationCall {
  /** Catalog ingredient slug that owns the connector surface. */
  slug: string;
  /** Short operation key from `manifest.operations` / `surfaces.connector.executes`. */
  operation_key: string;
  /** Fully qualified operation id from policy resolution, for diagnostics/audit. */
  operation_id: string;
  binding: CliMethodBinding;
  /** Resolved operation args used to fill argv/path templates. */
  args: Record<string, unknown>;
  /** Foreground timeout. Detached jobs use the runtime launch handshake instead. */
  timeout_ms?: number;
  /** Host-owned cancellation for owner kill and recipe-budget expiry. The CLI
   * executor terminates its whole owned process tree before settling. */
  signal?: AbortSignal;
  /** Host-only recursion guard for the supervisor's raw detached spawn. The
   * authored call was already classified before delegation; suppresses a
   * second, false "unsupervised detach" compatibility event after the
   * supervisor removes its declaration to reach the low-level launcher. */
  supervisor_managed_launch?: true;
  stepMeta?: StepMeta;
}

export type CliInvocationExecutor = (call: CliInvocationCall) => Promise<unknown>;

/** D-221 host-owned local Records executor. The engine supplies only a
 * verified installed binding, derived principal, and ordinary operation args. */
export type RecordsOperationExecutor = (
  call: RecordsExecutionCall,
) => unknown | Promise<unknown>;

/** D-201 Slice 6B3 — the server-only seam for an operation whose trusted
 * catalog declaration binds it to an owner-selected webhook ingress. Authored
 * args contain only ordinary provider inputs; the resolver returns a separate
 * dispatch-only object and a result projector so the canonical callback URL is
 * neither author-overridable nor visible in recipe step output. */
export interface OperationBoundWebhookConsumerIdentity {
  kind: 'pack_install' | 'local_recipe';
  id: string;
}

export interface OperationBoundWebhookCall {
  /** Server-derived durable provenance. Never derive this from an inline
   * recipe id or author-controlled recipe metadata. */
  consumer: OperationBoundWebhookConsumerIdentity;
  ingredient_slug: string;
  operation_id: string;
  execution_binding: Readonly<RestExecutionBinding>;
  logical_binding: string;
  intent: 'attach' | 'detach';
  connection_name: string;
  args: Readonly<Record<string, unknown>>;
}

export interface PreparedOperationBoundWebhookDispatch {
  dispatch_args: Record<string, unknown>;
  /** Re-check the final connection-adapter input after catalog lowering so an
   *  authored static body/query value cannot clobber an adapter-owned field. */
  validateDispatchInput(input: Readonly<Record<string, unknown>>): void;
  projectResult(result: unknown): unknown | Promise<unknown>;
  /** Any error after trusted injection may echo request configuration. Return
   *  only a bounded error safe for recipe execution; the phase lets core keep
   *  preparation failures distinct from provider/response failures. */
  projectError(
    error: unknown,
    phase: 'dispatch_preparation' | 'provider',
  ): Error;
}

export type OperationBoundWebhookResolver = (
  call: OperationBoundWebhookCall,
) => Promise<PreparedOperationBoundWebhookDispatch>;

/** Real-time execution progress events fired during a run. Consumers
 *  subscribe via `ExecutionContext.onProgress`. Events are delivered
 *  synchronously from the engine's execution thread — consumers should
 *  do minimal work (update a state machine, enqueue a UI redraw) and
 *  never block.
 *
 *  There are three categories of events:
 *
 *  1. Display-driving: `focus_update` carries a single step_id — the one
 *     the UI should show as "currently happening". Exactly the thing the
 *     user renders as `{on_icon}: {step_id}`. It fires at every phase
 *     transition and whenever the focus step changes. UIs that only care
 *     about "what's running right now" subscribe to this one event.
 *
 *  2. Detailed/audit: `prefetch_dispatched`, `prefetch_arrived`,
 *     `sequential_step_started`, `sequential_step_finished` carry per-step
 *     metadata (index, total, error, skipped flag). Audit logs, analytics,
 *     and detailed debuggers subscribe to these.
 *
 *  3. Output-ready: `render_ready` carries the full resolved
 *     `ExecutionResult.output.render` shape for progressive UI updates.
 *
 *  Focus semantics:
 *  - During the prefetch phase, focus = first non-arrival prefetch step
 *    in declaration order. If steps [A, B, C] are declared and B arrives
 *    first, focus stays on A until A actually arrives, then advances to
 *    C. This mirrors what the user is actually waiting on.
 *  - During the sequential phase, focus = currently-running sequential
 *    step. Advances on each `sequential_step_started`.
 *  - At recipe completion, focus = null with phase='done'.
 */
export type ProgressEvent =
  /** Display-driving: the single step_id the UI should show right now.
   *  step_id is null only when phase='done'. */
  | { type: 'focus_update'; phase: 'prefetch' | 'sequential' | 'done'; step_id: string | null }
  /** Audit: fires once at the start of the prefetch phase. */
  | { type: 'prefetch_dispatched'; step_ids: string[]; total: number }
  /** Audit: fires once per individual prefetch step as its promise resolves. */
  | { type: 'prefetch_arrived'; step_id: string; index: number; total: number; error: RecipeError | null; skipped: boolean }
  /** Audit: fires before each sequential step runs. */
  | { type: 'sequential_step_started'; step_id: string; index: number; total: number }
  /** Audit: fires after each sequential step completes (success, skip, or error). */
  | { type: 'sequential_step_finished'; step_id: string; index: number; total: number; skipped: boolean; error: RecipeError | null }
  /** D-068 / D-195: fires after each sequential step once all output render
   *  sources are resolved. Carries the full re-resolved render array so the UI can clear +
   *  re-render without waiting for execution_complete. */
  | { type: 'render_ready'; render: ResolvedOutputSection[] };

/** Callback supplied by the caller to receive progress events. */
export type ProgressCallback = (event: ProgressEvent) => void;

/** D-177 catalog-gate session-grant loop — the per-operation envelope the
 *  catalog gate hands the host's grant seam (the host adds the run-level
 *  context: `channel` / `actor` / `channel_session_id` / `recipe_id` /
 *  `recipe_hash`). Mirrors the commit Gateway's `SessionGrantGateCall`, but
 *  `operation_id` is ALWAYS present (a catalog hold is an operation hold) and
 *  `risk_tier` is the operation's effective tier. The P1b-equivalent hashes
 *  are computed by the catalog gate over the resolved operation `args` (a
 *  self-consistent basis — the gate hashes the same way at mint and match,
 *  so a grant provably matches its own repeat). */
export interface CatalogGrantCall {
  readonly ingredient_slug: string;
  readonly operation_id: string;
  readonly connection_name?: string;
  /** The operation's effective risk tier (`resolution.effective_risk_tier`).
   *  Read / write / admin are session-grantable (D-211 Slice 3);
   *  `destructive` never grants. */
  readonly risk_tier: RiskTier;
  /** D-209 §1.7 — approval captured before later review/quality lifts. */
  readonly pre_lift_approval: OperationApproval;
  readonly arg_shape_hash: string;
  readonly canonical_payload_hash: string;
  /** D-177 catalog open mode (N.11) — the FIRE's recomputed open-projection
   *  hash, present exactly when the gate's walk classified this dispatch
   *  (the `resolveOpenProjection` hook returned a computation). Absent ⇒ an
   *  `'open'` grant can never match this dispatch (the N.4 open arm fails
   *  closed without it); exact/batch matching is unaffected. */
  readonly open_pinned_projection_hash?: string;
  /** D-177 N.11 rule 5 (slice D) — the dispatch's CANONICAL email destination
   *  tokens, extracted from the op's resolved args over its N.2 authority
   *  paths (`extractScopedDestinationEmails` — v1 email shape only, 5.i.3).
   *  Present exactly when every non-structural authority value is
   *  email-shaped; absent ⇒ a `'scoped'` grant never matches (fail closed).
   *  The host's hook closure pairs them with the per-session forwarded-sender
   *  candidate index (5.d). */
  readonly destination_emails?: ReadonlyArray<string>;
}

/** D-177 catalog-gate session-grant loop — the mint-side sibling: the same
 *  envelope plus the offered bounds (off the resumed gated step's
 *  `preflight_session_grant` marker) and, for an `'open'`-mode answer, the
 *  projection trio recomputed from THIS resume dispatch's own walk (the D9
 *  basis — the same closure future fires are matched with). The host adds
 *  the approval anchor (`approved_action_ref`). Batch grants are never
 *  minted here — the batch coordinator mints from the answered ask's member
 *  snapshot (N.10). */
export interface CatalogGrantMintCall extends CatalogGrantCall {
  readonly ttl_ms: number;
  readonly max_uses: number;
  /** `'open'` exactly when the marker carried the open answer AND the gate's
   *  walk recomputed on the resume dispatch; absent ⇒ the P3 exact mint. */
  readonly grant_mode?: 'exact' | 'open';
  /** `'open'` only — the canonical hash over the resume dispatch's walk. */
  readonly pinned_projection_hash?: string;
  /** `'open'` only — the normative rule-6 structure the hash covers. */
  readonly open_projection?: OpenProjection;
}

/** D-177 catalog-gate session-grant loop — match / consume / mint (plus the
 *  P5a batch member claim and the P5b open-projection walk) over a catalog
 *  operation hold. The host builds it over the server's session-grant
 *  resolver (see `ExecutionContext.catalogSessionGrants`). */
export interface CatalogSessionGrantHooks {
  /** Match the envelope against live session grants for the run's channel
   *  session. Read-only. Returns the matched grant's `contract_id`, or `null`
   *  (⇒ the catalog gate raises the approval hold as today). */
  match(call: CatalogGrantCall): string | null;
  /** Consume one use at the dispatch proceed point. `call.
   *  canonical_payload_hash` selects the member a `grant_mode: 'batch'`
   *  consumption atomically claims (exact rows ignore it);
   *  `call.pinned_projection_hash` — the fire's recomputed projection hash —
   *  store-verifies an `'open'` consumption (defense in depth). `false` ⇒
   *  the grant died between match and consume — the catalog gate re-raises
   *  the hold (fail closed). */
  consume(
    contract_id: string,
    call?: {
      canonical_payload_hash: string;
      pinned_projection_hash?: string;
      /** Slice D — re-verifies a `'scoped'` consumption's 5.d containment at
       *  the store (the 5.a build constraint); exact/batch/open ignore it. */
      destination_emails?: ReadonlyArray<string>;
    },
  ): boolean;
  /** D-177 catalog batch (N.10) — atomically claim the NAMED member of a
   *  batch grant at a batch-approved resume's proceed point, hash-verified
   *  against THIS dispatch's envelope (a drifted resume re-asks, never
   *  spends the member). `false` / absent hook ⇒ the catalog gate re-raises
   *  the hold (fail closed — the marker must never dispatch unclaimed). */
  claimBatchMember?(
    contract_id: string,
    member_id: string,
    call: { arg_shape_hash: string; canonical_payload_hash: string },
  ): boolean;
  /** D-177 catalog open mode (N.11) — compute the catalog dispatch's open
   *  projection: the taint-propagation walk over the op's authority-bearing
   *  args. The host closes it over the run's recipe + live stores + manifest
   *  registry and gates on the OP's `authority_args` opt-in
   *  (`OperationSpec.authority_args` — an undeclared op never
   *  offers/matches/mints open; fail closed). `call.args` is the op's args
   *  AS DISPATCHED — the same object the gate's hash basis projects, refs
   *  unresolved (the walk reads ref strings out of it). The gate evaluates
   *  it LAZILY, at most once per dispatch, and only on ask-branch paths
   *  (admit/deny never pay the walk); a throwing/`undefined` result means
   *  open is not soundly computable for this dispatch and everything stays
   *  exact. MUST be synchronous — it runs inside the gate's await-free
   *  match → consume span. */
  resolveOpenProjection?(call: {
    readonly ingredient_slug: string;
    readonly operation_id: string;
    readonly args: Record<string, unknown>;
    readonly gated_step_id?: string;
  }): OpenProjectionComputation | undefined;
  /** Mint a session grant from a resume-admitted catalog dispatch's own
   *  envelope (the `allow_session` answer) — exact, or open when the marker
   *  + a successful walk say so. Best-effort, never throws — the
   *  human-approved dispatch proceeds regardless. */
  mint(call: CatalogGrantMintCall): void;
}

/** Everything the engine needs to run a recipe. */
/** D-232 — the host's in-process recipe runner, as the gateway sees it. The
 *  gateway owns policy, audit and the cycle guard; the host owns loading the
 *  recipe and re-entering `executeRecipe` with the widened `held_recipes`. */
export interface LocalRecipeInvokeCall {
  /** Publisher-qualified recipe id, taken from the binding's `tool` — NEVER
   *  from caller args. The binding owns the call target, which is what makes a
   *  recipe unable to redirect this at another recipe. */
  readonly recipe_id: string;
  readonly args: Record<string, unknown>;
  /** This call's ancestors PLUS `recipe_id`. The host threads it into the
   *  nested run so the guard composes down the tree. */
  readonly held_recipes: ReadonlySet<string>;
  /** Engine-generated structural address of this exact local invocation. */
  readonly invocation_path?: import('@recued/contracts').PreapprovalInvocationPath;
}

export type LocalRecipeInvoker = (
  call: LocalRecipeInvokeCall,
) => Promise<unknown>;

import type {
  ExchangeAcknowledgement,
  ExchangeFireHandler,
} from './fire-exchange-output.js';

export interface ExecutionContext {
  entry_tool_name?: string;
  governing_recipe_grant?: string;
  /** D-261 host-only addressing for the selected execution. Never copied from
   * a recipe's context namespace or a public execution request. */
  preapprovalAddressing?: {
    recipe_path: import('@recued/contracts').PreapprovalInvocationPath;
    phase: 'trigger' | 'prefetch' | 'sequential';
    iteration_indices: number[];
  };
  /** Host-private durable invocation control. These functions are never read
   * from recipe JSON, execution context data, tool args or resume markers. */
  reviewedExecution?: {
    invoke(call: { slug: string; input: Record<string, unknown>; output: Record<string, string> | undefined;
      catalog: boolean; connection_name: string; stepMeta: StepMeta | undefined;
      /** `StepOptions.pii_fields`: the dispatch hashes these keys in the resolved input. */
      pii_fields?: readonly string[] },
      dispatch: () => Promise<unknown>): Promise<unknown>;
    catalogApproved(call: { slug: string; operation_id: string; connection_name: string; stepMeta: StepMeta | undefined }): Promise<boolean>;
    delegate(call: { slug: string; input: Record<string, unknown>; stepMeta: StepMeta | undefined },
      dispatch: () => Promise<unknown>): Promise<unknown>;
  };
  /** Claims a next-auto-run candidate after qualification and before prefetch.
   * Ordinary runs and already-claimed scheduled runs do not install this hook. */
  afterTriggerQualification?: () => Promise<void | {
    reviewedExecution: NonNullable<ExecutionContext['reviewedExecution']>;
    preapprovalAddressing: NonNullable<ExecutionContext['preapprovalAddressing']>;
  }>;
  /** Engine-owned phase state; keeps a resumed approval on its exact phase. */
  executionPhase?: 'trigger' | 'prefetch' | 'sequential';
  prefetchCompleted?: string[];
  /** The recipe being run. D-182 §6/§10 step 7 — OPTIONAL: a raw op the LLM
   *  calls without a recipe (§8) forms an `ExecutionContext` with no recipe.
   *  The Gateway audits at the op level regardless; nothing synthesizes a fake
   *  recipe (that would pollute the recipe namespace + Memory's
   *  `recipe_insights`, which snapshots a real authored recipe's shape). Every
   *  recipe-shaped read is `ctx.recipe?.…`-guarded; the recipe-origin path is
   *  unchanged (a recipe is always present there). */
  recipe?: RecipeDefinition;
  /** D-222 — immutable authored snapshot identity for resolved filter
   *  provenance. A server dispatch may lower canonical ops before engine entry,
   *  changing the ordinary execution hash while the stored output section is
   *  unchanged; callers that own a stored snapshot pass its pre-lowering hash.
   *  Other engine hosts omit it and the execution hash is used. */
  outputRecipeHash?: string;
  stores: NamespaceStores;
  ingredientExecutor: IngredientExecutor;
  /** D-181 slice 4 — the execution-request anchor `run_id` for this run.
   *  Threaded into each gated call's `SlotDescriptor` so the long-op live
   *  active-list (`execution.active`) can group a run's heavy calls and the
   *  in-flight registry can map a kill back to the run. Host-set
   *  (`execute-handler` passes the `run_id` it minted); absent on dbless tests
   *  / client contexts that wire no governor anyway. */
  run_id?: string;
  /** D-181 slice 4 — a per-run abort signal the host (`execute-handler`)
   *  aborts when the owner kills the run via the live active-list. Threaded
   *  into every gated call's `SlotRequest.signal`, so killing a run rejects its
   *  *queued* heavy calls (they never dispatch) while a SIGKILL handles the
   *  *running* subprocess. Absent ⇒ no kill path (dbless tests / client
   *  contexts). The engine never aborts it — it is a host-driven input. */
  runAbortSignal?: AbortSignal;
  /** Optional server-side executor for catalog connector bindings with
   *  `kind: "cli_invocation"`. When absent, admitted CLI catalog ops fail
   *  closed after the catalog gate with `no_cli_executor`. */
  cliInvocationExecutor?: CliInvocationExecutor;
  /** D-221 first kernel gate for a core.records catalog operation. The
   * namespace gate remains inside the Records store transaction. */
  recordsReachabilityResolver?: (
    principal: string | null,
    ingredient_id: string,
    operation_id: string,
    binding: RecordsExecutionBinding,
  ) => boolean;
  /** D-221 server-local dispatch after the ordinary catalog policy/approval
   * path admits. Absent means Records fails closed. */
  recordsOperationExecutor?: RecordsOperationExecutor;
  /** D-232 — in-process dispatch for an `mcp` binding that names a LOCAL
   *  recipe. There is no separate declaration for local vs remote: the binding
   *  names a recipe and the GATEWAY routes. A connection present means a peer's
   *  server (JSON-RPC `tools/call`); a connection absent means this one, and the
   *  call never leaves the process. Absent resolver ⇒ fails closed with
   *  `no_local_recipe_invoker`, exactly as Records does.
   *
   *  ⛔ The invoker MUST pass `held_recipes` down into the nested run's own
   *  {@link ExecutionContext.heldRecipes}, or the cycle guard protects only the
   *  first hop and A→B→A walks straight through. */
  /** D-232 § 19 — the post-run fire point's host hook. A recipe declaring
   *  `output.exchange` on a host that leaves this absent FAILS the run rather
   *  than completing having answered nobody. */
  exchangeFireHandler?: ExchangeFireHandler;
  localRecipeInvoker?: LocalRecipeInvoker;
  /** D-232 — may a run here dispatch to this local recipe? The authorization
   *  source for the connectionless mcp kind, mirroring
   *  `recordsReachabilityResolver`. ⛔ ABSENT DENIES (Invariant 3): a host that
   *  has not opted in does not acquire recipe-to-recipe dispatch by upgrading. */
  localRecipeReachabilityResolver?: (
    target_recipe_id: string,
    operation_id: string,
  ) => boolean;
  /** D-232 — every recipe already on this call's stack, self included, as the
   *  gateway walks the dispatch tree. Modelled on `SlotRequest.held_lanes`
   *  (D-181 §5), which threads exactly this shape for exactly this reason: the
   *  non-reentrancy guard. Empty/omitted at the top level. */
  heldRecipes?: ReadonlySet<string>;
  /** Host-minted Records watcher lineage inherited by any mutation this run
   * performs. Not sourced from recipe/context/config data. */
  recordsMutationContext?: Pick<
    RecordsExecutionCall,
    'execution_lease_id' | 'root_event_id' | 'causal_depth' | 'watcher_digest'
  >;
  /** D-201 Slice 6B3 — trusted callback binding/injection. An operation that
   *  declares `operation_bound_webhook` fails closed when this resolver is
   *  absent; ordinary operations never call it. */
  operationBoundWebhook?: OperationBoundWebhookResolver;
  /** Durable consumer provenance supplied by the server for a stored recipe.
   *  Inline/transient recipes leave this absent and cannot borrow another
   *  recipe or pack's operation-bound webhook authority. */
  operationBoundWebhookConsumer?: OperationBoundWebhookConsumerIdentity;
  /** SMB-finance slice 3 — server-side sink that lands a captured REST
   *  download body (a `response_capture` op, e.g. storage-gdrive
   *  `file.download`) into the CAS (`data.file.received`) and returns the
   *  record_id. The base64 bytes transit here in memory only — the gateway
   *  ingests them and returns a `file_ref` with the bytes stripped (D-172
   *  content isolation). Absent ⇒ an admitted `response_capture` op fails
   *  closed with `no_file_ingestor` (mirrors `no_cli_executor`). */
  ingestFileDownload?: (input: {
    bytes_b64: string;
    filename: string;
    mime_type: string;
    source_id: string;
    /** The op's `response_capture.ai_enrichment`, carried to the stored file. */
    ai_enrichment?: 'opt_out';
  }) => Promise<{ record_id: string }>;
  /** D-217 slice 2b-ii-β2 — size + content pin for the file a CHUNKED upload
   *  will send, read from the file record's metadata.
   *
   *  🔑 **Metadata only, and that is the whole point.** The engine needs the
   *  plaintext SIZE to fix the request count before dispatch (`ceil(size /
   *  chunk_bytes)` — the number the owner approves), and it needs the content
   *  hash to pin which bytes that count was computed for. Neither requires
   *  decrypting anything.
   *
   *  ⛔ **The engine deliberately does NOT stage.** An earlier shape had it
   *  stage here and put the resulting token on the dispatch input; the action-
   *  identity hash covers that input and drops nothing engine-owned, so a fresh
   *  token per attempt meant a fresh `canonical_payload_hash` and a D-177 grant
   *  that could never match an honest repeat. Staging lives in the connection
   *  adapter, below the commit boundary — see
   *  `ConnectionApiHandlerDeps.uploadStaging`. A side benefit worth keeping:
   *  the owner's decrypted plaintext then exists only for the walk itself,
   *  never across hashing, admission or an approval hold.
   *
   *  Absent dep or an unknown ref ⇒ the chunked op fails closed (mirrors
   *  `no_file_ingestor`). */
  describeUploadSource?: (file_ref: string) => Promise<{
    size_bytes: number;
    content_hash: string;
  } | undefined>;
  /** Optional progress callback. Fires as individual prefetch steps
   *  resolve and before/after each sequential step. Exceptions thrown
   *  from the callback are swallowed — they never disrupt execution. */
  onProgress?: ProgressCallback;
  /** Opt-in preflight validation. When true, the engine runs
   *  `parseRecipe` before executing. If the recipe fails validation, the
   *  engine returns an `ExecutionResult` with success=false and a
   *  single synthetic error listing the validation issues. When false
   *  (the default), the engine executes without any structural checks —
   *  useful for tests and trusted internal callers. */
  strict?: boolean;
  /** Optional manifest getter for role-based adapter restriction checks and
   *  catalog-form dispatch. When a recipe step carries `ingredient_version`,
   *  the engine passes it as `requestedVersion`; a null result fails that step
   *  closed before the unpinned executor can run.
   *  When provided, the engine verifies that no ingredient requires a
   *  browser-only adapter (DOM, Chat) when running on the server.
   *  Omit to skip the check (backward compatible). */
  manifestGetter?: (slug: string, requestedVersion?: number) => IngredientManifest | null;
  /** Entity-field lookup for a `record_fields` output block: the installed
   *  pack's declaration for `<entity>`, normalized across the two runtime
   *  shapes (`surfaces.records.schema.entities` for a storage ingredient,
   *  `entity_schemas[].meta_fields` for an http one — 11 packs versus 221).
   *
   *  Deliberately NOT read off `manifestGetter`. Supplying that getter turns on
   *  the D-165 catalog gateway, so deriving a purely presentational label set
   *  through it would couple "can this recipe show a field name" to "does this
   *  recipe hold an operation grant" — two unrelated questions, and the block
   *  would go blank on a grant failure rather than on a schema failure. It also
   *  spares the engine guessing WHICH catalog a bare entity kind belongs to.
   *
   *  Omit and every `record_fields` block resolves `unresolved: 'no_schema'` —
   *  which reads as "could not look it up", never as "the record is empty". */
  entityFields?: (entity: string) => readonly EntityFieldDeclaration[] | null;
  /** D-181 Slice 2 — the long-op execution governor. Before each ingredient
   *  call the engine classifies it by kind (`callClassForKind` over the
   *  manifest) and acquires a lane slot from this governor; the heavy call then
   *  runs **inline, awaited, inside the run** (audited as a step — no job rows).
   *  Fast-path / ai-governor calls bypass instantly. When omitted, the engine
   *  uses `NO_OP_LANE_GOVERNOR` (grants every request immediately), so behaviour
   *  is identical to the pre-D-181 path — dbless tests and client contexts leave
   *  it unset. The server wires its singleton two-lane `LaneSemaphore`. */
  laneGovernor?: LaneGovernor;
  /** D-181 Slice 2 — lanes held by this call's *ancestors* in the dispatch
   *  tree. A **host-provided, read-only input** (the engine never mutates it):
   *  the governor's non-reentrant guard returns an inherited (no-slot) lease
   *  when a call's target lane is already in this set, so a same-lane nested
   *  call cannot deadlock at `N = 1`.
   *
   *  **Dormant in slice 2** — `executeRecipe` is never nested (the sole call is
   *  the top-level dispatch in `execute-handler`; ingredient executors spawn
   *  subprocesses, they do not re-enter the engine), so no nested governed call
   *  is reachable and no host populates this yet. It is wired and unit-tested at
   *  the semaphore level, ready for whenever a future slice threads a nested
   *  governed dispatch (which must then set child `heldLanes = parent ∪ {lane}`). */
  heldLanes?: ReadonlySet<ExecutionLane>;
  /** D-181 §10 — the duration-threshold classifier (default-gated refinement of
   *  the static op-kind classification). `resolveCallClass` consults it to demote
   *  a gated-kind op to `fast-path` once it has proven itself fast (< the
   *  threshold), and `invokeGoverned` records each successful call's duration into
   *  it. Omitted ⇒ `NO_OP_OP_DURATION_CLASSIFIER` (no demotion, behaviour
   *  identical to the pre-§10 kind-only path). The server wires its in-memory
   *  singleton. */
  opDurationClassifier?: OpDurationClassifier;
  /** Optional L2 step cache — content-addressable per-step memoization
   *  for sequential steps. When set, the engine analyzes the recipe's
   *  steps once, computes a content-hash key per step (source +
   *  resolved deps), and short-circuits execution on cache hit. Prefetch
   *  is NOT wrapped here — it's already covered by the L1 ingredient
   *  cache, and its outputs flow into the sequential-step dep hashes
   *  so the L2 keys stay correct. When omitted, the engine runs every
   *  step fresh (legacy behavior, backward compatible). */
  /** Optional async resolvers for the `shared.*` + `data.shared.*`
   *  namespaces (D-103 Phase A). When set, the engine pre-fetches refs
   *  under these namespaces before each step executes and splices the
   *  results into `stores.shared` / `stores.data.shared` so the sync
   *  resolver pipeline can walk them. Omit to run with purely in-memory
   *  stores (matches earlier behaviour). */
  sharedResolvers?: SharedResolvers;
  /** D-116 — Hook for transforms that pause deliberately (e.g. `wait`)
   *  to exclude their sleep from `metadata.budget_ms`. `executeRecipe`
   *  installs one when `budget_ms > 0` so the wall-clock timer is
   *  extended by each `wait` call — same treatment as D-094 approval
   *  waits. Hosts that call executeRecipeInner directly for recipes
   *  with no budget can leave this unset. */
  extendBudget?: (ms: number) => void;
  /** D-125 P6.2 — server-only hook backing the `enrichment-or-fetch`
   *  transform. Reads the freshest enrichment row keyed on `(topic,
   *  scope, target_id)` including row-level metadata (event_at /
   *  ingested_at / stale / confidence). The recued-server engine
   *  wires this to the warehouse-resident `EnrichmentStore`; callers
   *  that leave it undefined (dbless tests) make the transform fall
   *  through to `source: 'no_runtime'` instead of hard-failing. */
  readEnrichmentRow?: (
    topic: string,
    scope: import('@recued/contracts').EnrichmentScope,
    target_id: string,
  ) => import('@recued/transforms').EnrichmentRowSnapshot | null;
  /** D-167 P4 — run-local ledger store for the recipe-mode `pii-protect` /
   *  `pii-restore` transforms. `executeRecipeInner` mints one per run when the
   *  caller hasn't supplied one, so the real PII values bridge the protect and
   *  restore steps in pure process RAM and are dropped (GC'd) when the run
   *  returns — no cross-run sharing. Threaded into every `TransformContext`. */
  piiLedgerStore?: import('@recued/transforms').PiiLedgerStore;
  /** D-316 amendment — the server's whole-warehouse known-value matcher (the
   *  chat's), which `pii-protect` runs over every `content`-tagged value. A
   *  getter, called only when a step tags present content. Threaded into every
   *  `TransformContext`; absent on hosts with no warehouse. */
  piiKnownValues?: () => import('@recued/transforms').PiiKnownValueSource | undefined;
  /** D-165 P0 — resolve the LOCAL-ONLY per-connection operation profile
   *  (grants + risk/approval overrides) for a catalog-form dispatch. The
   *  engine calls this when a step targets a catalog-form ingredient
   *  (manifest carries `operations`); the resolved profile gates the
   *  operation per `resolveCatalogOperationPolicy`. When unset (dbless
   *  tests, no profile store wired), catalog-form calls fail closed with a
   *  `no_connection_profile` deny — operations default OFF (Invariant 3).
   *  Server wires this from its per-connection profile store; the full
   *  `contract.*` namespace lands in D-165 P2+. */
  connectionProfileResolver?: (
    connection_name: string,
  ) => ConnectionOperationProfile | null | Promise<ConnectionOperationProfile | null>;
  /** D-182 §7.2 — per-contract cli reachability check, the AUTHORITATIVE `cli`
   *  kind `authorized` preflight stage (increment 3). The gateway calls this —
   *  instead of `connectionProfileResolver` — for a catalog op whose connector
   *  binding is `cli_invocation`: may a recipe run under `principal` (the
   *  resolved full execution source → principal, see
   *  `cliPrincipalFromExecutionSource`; this includes a server-derived owner
   *  schedule while keeping other contract-free system work at `null` ⇒ deny)
   *  reach this cli `ingredient_id`'s `operation_id`? A connection-less by-value
   *  cli pack has no connection profile to seed (the `no_connection_profile`
   *  gap), and cli is pack-only, so its authorization is a (contract × pack-op)
   *  allowlist: this independent per-(principal × ingredient × operation)
   *  reachability grant (absent row ⇒ false ⇒ deny, fail closed), read DIRECTLY
   *  — never the tightening-only merge. Risk tier is NOT a key here; it only
   *  drives owner-notification at the approval stage. When unset (dbless tests, no
   *  reachability store wired) OR no allowlist row admits, cli catalog ops fail
   *  closed with a `cli_reachability_disabled` deny — reachability defaults OFF
   *  (Invariant 3). Server wires this from its local cli-reachability store. */
  cliReachabilityResolver?: (
    principal: string | null,
    ingredient_id: string,
    operation_id: string,
  ) => boolean;
  /** D-165 P3.path-picker (Slice 3b) — resolve a connection's stored
   *  `subresource_path` (the permission boundary set at enrollment) for a
   *  catalog-form dispatch. The gateway calls this ONLY when the dispatched
   *  operation declares a `path_scope` contract; the resolved path is the scope
   *  `checkPathScope` enforces the call's target path against. Returns
   *  `undefined` for an unscoped connection (whole-account) or when no
   *  connection-record store is wired (dbless tests) — `checkPathScope`
   *  canonicalizes `undefined` to `/`, so an absent path means whole-account
   *  access (the pre-path-picker default; path scope only ever RESTRICTS a
   *  connection that carries a `subresource_path`). Distinct from
   *  `connectionProfileResolver`: `subresource_path` is a CONNECTION-RECORD
   *  attribute, not grant state. Server wires it from its connection store. */
  connectionSubresourcePathResolver?: (
    connection_name: string,
  ) => string | undefined | Promise<string | undefined>;
  /** Resolve the enrolled API connection's concrete base URL for REST
   *  continuation safety checks. Used by operation-local `link_header`
   *  pagination so GitHub Enterprise / Salesforce instance URLs compare
   *  against the user's actual connection, not only the catalog default.
   *  Returns undefined when no connection row is available; the gateway then
   *  falls back to the catalog's `default_base_url`. */
  connectionBaseUrlResolver?: (
    connection_name: string,
  ) => string | undefined | Promise<string | undefined>;
  /** D-165 P0 — per-call gateway audit sink (Invariant 5). The engine
   *  invokes this once for every gateway-routed catalog-form call —
   *  success AND failure — with the resolved (catalog-derived) operation
   *  policy. The host emits it as a `connection_gateway` activity row into
   *  the D-120 audit store with `source: 'connection.gateway'`. Best-
   *  effort: exceptions thrown from the sink must not disrupt execution
   *  (the engine swallows them). Omitted → no gateway audit (silent
   *  no-op); recipe execution unaffected. */
  onGatewayCall?: (event: GatewayCallAudit) => void;
  /** Optional synchronous host reservation at the catalog gate's final
   * post-approval proceed point. A throw refuses the call before CLI/API work.
   * Used by direct-MCP customer usage; ordinary recipe contexts omit it. */
  onCatalogDispatchProceed?: (call: {
    readonly ingredient_slug: string;
    readonly operation_id: string;
    readonly args: Record<string, unknown>;
    readonly connection_name: string;
  }) => void;
  /** D-177 catalog-gate session-grant loop — the match / consume / mint
   *  seam for CATALOG-operation holds (`runCatalogOperation`), mirroring the
   *  commit Gateway's `sessionGrants` (`packages/gateway`). A catalog op
   *  holds at the catalog gate (operation-level policy), BEFORE the commit
   *  Gateway — and its eventual dispatch is read-tier there (the catalog
   *  ingredient is `risk_tier: read`), so the commit Gateway's grant seam
   *  never fires for it. This seam lets the catalog gate absorb a repeated
   *  approval the same way: an `ask` verdict consults a live session grant
   *  before raising, and an `allow_session` resume mints one from THIS
   *  dispatch's own envelope.
   *
   *  The host (`execute-handler`) supplies the run-level context the catalog
   *  gate lacks — `channel` / `actor` / `channel_session_id` (off
   *  `CommitRunIdentity`) and the recipe identity (`recipe_id` +
   *  `recipe_hash`) — closing over them so the gate passes ONLY the per-op
   *  envelope. All three grant modes run here: exact (the v1 loop), batch
   *  (N.10 — the gate claims the resumed member via `claimBatchMember` and
   *  a replay claims through the matcher's batch arm), and open (N.11 —
   *  gated on the op's `authority_args` opt-in through
   *  `resolveOpenProjection`). Absent (dbless / unit / no resolver) ⇒ every
   *  catalog `ask` holds exactly as pre-loop. */
  catalogSessionGrants?: CatalogSessionGrantHooks;
  /** D-136 P7.E — origin of the recipe execution. Surfaced on
   *  `StepMeta.trigger_source` so kernel storage adapters that read
   *  enrichment data can apply policy gates (e.g. `mcp_exposed:
   *  'private'` rejection on the MCP-triggered path). Closed list of
   *  values mirrors `ExecuteRequest.trigger_source`; the engine forwards
   *  the string verbatim. Hosts that don't have a meaningful trigger
   *  source (dbless tests) leave it absent. */
  trigger_source?: string;
  /** D-166 Slice 4d.3 — the actor identity driving this execution
   *  (`execution_source.actor` — the D-153 `(channel × actor)` policy-
   *  matrix actor: `'user_self' | 'contracted_user' | 'system' |
   *  'anonymous'`). Threaded from the host's
   *  `ExecuteRequest.execution_source` so the catalog gateway
   *  (`runCatalogOperation`) can resolve the
   *  `contract.override` scope's required `actor` segment — the
   *  user-authored per-actor TIGHTENING layer — at dispatch. 4d.3 only
   *  makes the actor available on `ctx` (the field rides `ctx` exactly
   *  like `trigger_source` / `connectionProfileResolver` / `onGatewayCall`).
   *  Consumed by the catalog gateway's override-tightening layer (4d.4 —
   *  `runCatalogOperation` keys the `contract.override` scan on it). Absent
   *  on dispatch paths that carry no `execution_source` (dbless tests, legacy
   *  direct-rpc) — the override scope then matches no row, the tightening
   *  layer is simply not applied, and the existing connection-keyed
   *  profile floor stands unchanged (which itself fails closed per
   *  Invariant 3). */
  actor?: Actor;
  /** D-161 P1 — the contract in force on this execution, when contracted
   *  (`executionSourceContractId(execution_source)`). Threaded alongside
   *  `actor` so kernel write-handlers can stamp the `origin_contract_id`
   *  half of the D-161 origin provenance facet exactly when the run was
   *  contracted (N.4). Rides `ctx` like `actor` / `trigger_source`;
   *  forwarded onto `StepMeta.contract_id` by `buildStepMeta`. Absent for
   *  an unrestricted `user_self` / `system` / `anonymous` run, and on
   *  dispatch paths with no `execution_source`. */
  contract_id?: string;
  /** D-192 6c.2c — the STEP id whose work-entity VENDOR create was pre-approved by
   *  a create-plan confirm (the specific write the ask enumerated). Set ONLY by the
   *  create-plan re-run wiring (an internal server override, off `ExecuteRequest`),
   *  carrying the id of the step that raised `create_plan_required`. `buildStepMeta`
   *  stamps `StepMeta.work_entity_write_preadmitted = true` on THAT step only, so a
   *  re-run admits exactly the confirmed write — never another `ask`-create that
   *  happens to sit in the same replayed recipe. Absent on every normal / chat /
   *  MCP / recipe run (those writes gate unchanged). */
  work_entity_write_preadmitted_step_id?: string;
  /** D-182 §6/§10 step 7 — the full `(channel × actor × contract_id)` provenance
   *  source of this execution (D-153/D-161), threaded from the host's
   *  `ExecuteRequest.execution_source`. Carried verbatim onto every
   *  `GatewayCallAudit` so a gateway call is op-level auditable independent of a
   *  recipe (the recipe-less raw-op path, §8). Superset of the derived `actor` /
   *  `contract_id` above (those stay for their existing policy consumers); this
   *  carries the channel + per-channel ids (`turn_id` / `agent_id` / …) the
   *  origin-unit derivation + provenance attribution need. Absent on dispatch
   *  paths that wire no source (dbless tests, legacy direct rpc) — the audit
   *  fields are then simply omitted (Invariant: an audit field never breaks
   *  dispatch). */
  execution_source?: ExecutionSource;
  /** D-209 #1 — the run's resolved `ContractSnapshot`, threaded from the host's
   *  `ExecuteRequest.contract_snapshot` alongside `execution_source`. The catalog
   *  gateway reads its authored `max_risk_without_approval` (when the snapshot is
   *  the source's own door) so the dispatch ceiling is PER-DOOR rather than the
   *  flat contracted default. Absent (every dispatch before D-209 #1, dbless
   *  tests, legacy direct rpc) ⇒ `resolveTrustCeiling` falls back to its flat
   *  defaults — behavior-preserving by construction. */
  contract_snapshot?: ContractSnapshot;
  /** D-182 §6/§10 step 7 — the run's intent-burst correlation id, threaded from
   *  the host alongside `execution_source`. Feeds `deriveOriginUnit` (with
   *  `run_id`) to compute a call's `origin_unit_id` for the audit: an `mcp`
   *  burst groups by `correlation_id`, a chat turn falls back to it when no
   *  `turn_id` is plumbed. Absent ⇒ the origin unit falls back to `run_id` (or
   *  the audit `origin_unit_id` is omitted when no source is wired at all). */
  correlation_id?: string;
  /** D-166 Slice 4d.4 — injected `contract.*` scan callback (a thin adapter
   *  over the local-only `ContractStore.scan`, built by the host via
   *  `createContractScanFn`). The catalog gateway uses it — together with
   *  `actor` — to compose the user's `contract.override` rows for the
   *  `(actor, ingredient_id, operation_id)` being dispatched and TIGHTEN the
   *  connection-keyed profile-floor resolution (deny / escalate approval; the
   *  override layer only ever restricts, never loosens). The closure reads the
   *  store live on each call, so a freshly-written override takes effect mid-
   *  session. Unset on dbless / unit paths (no store) → the override layer is
   *  skipped and the connection-keyed floor stands unchanged. */
  contractScan?: ScanFn;
  /** D-120 Phase 3 — provenance link sink. When wired, the engine
   *  emits one `EmittedLink` per side-effecting ingredient step's
   *  resolved `data.<col>.<id>` reference (filtered through
   *  `shouldLink` + classified by `classifyKind`). Caller correlates
   *  with the audit row's `run_id` (memory_id) at append time and
   *  writes the rows to the `links` SQLite table.
   *
   *  Skipped entirely when `recipe.provenance === false`. */
  linkSink?: (link: EmittedLink) => void;
  /** D-120 Phase 4.5 — pre-loaded `context.recipe.*` snapshot from a
   *  prior run of the same recipe. Hosts read this from their per-pair
   *  store before calling `executeRecipe`. The engine populates
   *  `stores.context.recipe` with the snapshot before any step
   *  executes. Null / omitted on first run (or after a manual reset);
   *  the recipe's `coalesce` wrappers fall through to first-run
   *  defaults. */
  contextRecipeSnapshot?: ContextRecipe | null;
  /** D-120 Phase 4.5 — callback fired after the run finishes
   *  successfully with the snapshot the engine computed for the next
   *  run. Hosts persist the snapshot to their per-pair store on cron +
   *  manual runs.
   *
   *  ⛔ Reactive (`auto_run`) is OUT OF SCOPE — deliberately, not pending
   *  (closed 2026-07-27). The engine still emits the snapshot on every
   *  successful run because it does not know the trigger source; the
   *  server host DROPS it for `auto_run` (`execute-handler.ts`, gated
   *  `trigger_source !== 'auto_run'`). Reactive continuity is a PAIRED
   *  RECIPE with a convergent write, not an engine snapshot — see
   *  internal design notes. Do not add a
   *  reactive commit boundary here.
   *
   *  Skipped when the run failed, was trigger-skipped, or the recipe
   *  doesn't reference `{{context.recipe.*}}` at all (manifest-driven
   *  no-op). The `truncated` array carries step ids dropped during
   *  size-cap reduction so the host can surface a warning. */
  onContextRecipeSnapshot?: (result: ContextRecipeSnapshotResult) => void;
  /** Read fresh before a write (`step-seed.ts`): the host's word on what each
   *  step does to the owner's records. When set, a recipe with any `write` step
   *  reads every `own_read` step fresh through BOTH cache tiers (the L2 step
   *  cache and the host's L1 ingredient cache, via `StepOptions.cache`) unless
   *  the step names its own `cache`. Absent ⇒ caching as before. */
  stepEffect?: (step: RecipeStep) => StepEffect;
  /** Engine-internal — the step ids `stepEffect` made fresh for this run,
   *  computed once at `executeRecipe` start. */
  readFreshSteps?: ReadonlySet<string>;
  stepCache?: {
    store: import('@recued/cache').CacheStore;
    /** Per-slug policy resolver. Typical wiring: a thunk over
     *  `derivePolicy(manifestGetter(slug))`. Return null when the
     *  slug is unknown so the wrapper can skip safely.
     *
     *  `category` (when supplied) is stamped on the CacheEntry so the
     *  broadcast policy can treat L2 ingredient-step outputs the same
     *  way it treats L1 ingredient cache entries — `data` / `ai`
     *  entries flow across the pair WS, `action` / unclassified don't. */
    ingredientPolicy: (slug: string) => {
      cacheable: boolean;
      ttl_seconds: number;
      category?: 'data' | 'ai' | string;
    } | null;
    /** Per-slug manifest version resolver. When provided, the version
     *  is folded into every ingredient step's sourceHash so a manifest
     *  bump (v1 → v2 with the same slug) produces a new cache key and
     *  retires stale entries automatically. Omit (or return null) on
     *  hosts that don't track versions — the step cache still works,
     *  it just won't self-invalidate on ingredient upgrades. */
    getIngredientVersion?: (slug: string) => string | number | null | undefined;
    /** Optional observability callback. Fires on every sequential step
     *  with hit / miss / skipped and the reason when skipped. */
    onStatus?: (
      status: 'hit' | 'miss' | 'skipped',
      ctx: { step_id: string; key?: string; age_ms?: number; reason?: string },
    ) => void;
  };
  /** D-157 / D-261 resume mode. The checkpoint's phase selects where the
   *  engine continues. For a legacy sequential hold, trigger_steps + prefetch
   *  and every sequential step before `gated_step_id` are skipped, and execution
   *  starts AT `gated_step_id` (its boundary-crossing call now dispatches
   *  exactly once — the call that drew the original `ask` verdict, now
   *  approved). `ctx.stores.step` must be pre-seeded by the host from the
   *  `Checkpoint.step_state` snapshot so the resumed steps' `{{step.*}}`
   *  refs resolve against the steps that already ran (TR-5 — no step
   *  before the gate runs twice).
   *
   *  Recipe-static and caller-injected namespaces (`config` / `meta` /
   *  `context` / `connection` / `vault`) are re-seeded fresh on resume —
   *  the engine populates them exactly as for a fresh run, which also
   *  correctly picks up any credential rotation that happened while the
   *  run was paused. `vault` never persists to the checkpoint (D-157
   *  § N.3); rotation safety follows.
   *
   *  Spec: D-157 § A.2 + I-6 / I-7. */
  resumeFrom?: {
    /** Exact paused phase. Legacy checkpoints resume sequential steps. */
    execution_phase?: 'trigger' | 'prefetch' | 'sequential';
    trigger_state?: Record<string, unknown>;
    prefetch_completed?: string[];
    /** Id of the step the checkpoint was minted at — within its recorded
     *  phase (sequential when absent). An unknown id surfaces as a fatal
     *  `CHECKPOINT_STEP_NOT_FOUND` error (the recipe drifted out from
     *  under the checkpoint between pause and resume). */
    gated_step_id: string;
    /** Exact foreach item/progress when the gate was raised mid-loop. */
    foreach_progress?: ForeachCheckpointProgress;
    /** Exact chunked-request budget approved for the resumed dispatch. In a
     * foreach this admits only the current item; a following item must raise
     * its own bounded approval. */
    egress_bound?: { readonly requests: number; readonly total_bytes: number };
    /** D-165 follow-on (op-identity binding) — the identity the user
     *  approved (`Checkpoint.approved_target`). The engine threads it onto
     *  the resumed gated step's `StepMeta.preflight_approved_target`; the
     *  catalog gate honors `preflight_admitted` only when the re-resolved
     *  `(ingredient, operation, connection)` matches it, re-raising a fresh
     *  ask on drift (fail closed). Absent ⇒ the catalog gate does not honor
     *  the position-only admission (it re-asks); the simple-form gate stays
     *  position-bound regardless. */
    approved_target?: PreflightApprovedTarget;
    /** D-173 N.5 — editable args at the approval gate. The consumed
     *  `Checkpoint.arg_overrides` (when the admin-only
     *  `reception.inbox.approve` rpc approved-with-edits). The engine
     *  shallow-merges these over the GATED STEP's authored/prefilled args
     *  before dispatch, and ONLY the gated step's — every other step's
     *  args are untouched. Absent ⇒ resume is byte-identical to D-157's
     *  binary approve/deny path.
     *
     *  Boundary (D-173 N.5 MUST). The engine reads overrides EXCLUSIVELY
     *  from this field, which the host populates EXCLUSIVELY from the
     *  consumed checkpoint (`internal.resume_from.arg_overrides`, written
     *  in `buildResumeInputs` off `checkpoint.arg_overrides`) — never from
     *  caller / channel / context input. The merge is wholesale: the edits
     *  were already validated against the operation's `ArgEditSchema`
     *  allowlist by `reception.inbox.approve` (N.6) before reaching the
     *  checkpoint; the engine does not re-allowlist. */
    arg_overrides?: Record<string, unknown>;
    /** D-177 P3 — the `allow_session` answer's mint instruction (the bounds
     *  the ask offered). The engine threads it onto the resumed gated step's
     *  `StepMeta.preflight_session_grant` — and ONLY the gated step's — so
     *  the commit Gateway mints a session grant from that dispatch's own
     *  envelope (the D9 merged-args basis). Sourced EXCLUSIVELY from the
     *  preflight answer context (`PreflightResumer.resumeRun` populates
     *  `internal.resume_from.session_grant` only when the recorded answer
     *  was `allow_session`) — never from caller / channel / context input.
     *  Absent ⇒ resume is byte-identical to the plain approve path.
     *  D-177 P5b — `grant_mode: 'open'` instructs the Gateway to mint the
     *  N.11 provenance-pinned grant instead of the exact-hash one; the
     *  engine threads it opaquely (the Gateway validates the mode). */
    session_grant?: {
      ttl_ms: number;
      max_uses: number;
      risk_tier: string;
      grant_mode?: string;
    };
    /** D-177 P5a (N.10) — the batched approve's member-claim instruction
     *  for THIS held run. The engine threads it onto the resumed gated
     *  step's `StepMeta.preflight_batch_claim` — and ONLY the gated
     *  step's — so the commit Gateway atomically claims the named member
     *  of the `grant_mode: 'batch'` grant at the dispatch proceed point
     *  (the claim IS the consumption — N.4; a member an agent replay
     *  already claimed re-holds, so the approved budget is never
     *  exceeded). Sourced EXCLUSIVELY from the batch answer flow
     *  (`backend/server/src/batch-approval.ts` populates the resume
     *  context per member) — never from caller / channel / context
     *  input. Absent ⇒ resume is byte-identical to the plain approve
     *  path. */
    batch_claim?: { contract_id: string; member_id: string };
    /** § 7 follow-on (pii-ledger-in-checkpoint) — the consumed
     *  `Checkpoint.pii_ledgers` snapshot. When present, the engine HYDRATES
     *  its run-local `PiiLedgerStore` from it instead of minting an empty
     *  one (ownership/dispose discipline unchanged — the engine still owns
     *  the store it minted), so `step.<protect>.ledger_handle` strings
     *  seeded from `step_state` resolve and post-gate `pii-restore` steps +
     *  the run-end `restoreAll` safety net return REAL values instead of
     *  passing aliases through. Absent ⇒ a plain fresh store, byte-identical
     *  to the pre-snapshot resume path (aliases would pass through exactly
     *  as before for legacy checkpoints). */
    pii_ledgers?: PiiLedgerStoreSnapshot;
  };

}

/** Per-step audit record. */
export interface StepLog {
  id: string;
  type: 'transform' | 'ingredient' | 'guard' | 'prefetch';
  skipped: boolean;
  /** Human-readable reason when `skipped` is true. Populated for
   *  `skip_when` conditions and for `kind: 'connection'` picker gates
   *  when the bound connection record is missing. Omitted for
   *  non-skipped steps. */
  skip_reason?: string;
  /** Present on the step whose `stop_when` held: the run ends after it, as a
   *  success. */
  stopped?: true;
  result: unknown;
  error: RecipeError | null;
  duration_ms: number;
  /** Per-item tally for a `foreach` step. Present only on those.
   *
   *  ⛔⛔ Why this exists. A `foreach` is continue-on-error by design: each
   *  iteration's failure lands in that item's `{ ok: false, error }` and the
   *  STEP still returns `error: null`, so `errors[]` stays empty and `success`
   *  stays true. That is correct — a partial write is not a failed run — but it
   *  made total failure indistinguishable from total success at every surface
   *  above the step output. Three separate defects shipped that way in one pack:
   *  a wrong `<kind>/` reference prefix, a submission missing its row identity,
   *  and a missing required field. Each refused EVERY item, and each month
   *  reported success having written nothing.
   *
   *  A recipe can already see this — it reads `{{step.x}}` and filters on
   *  `ok`. The gap was that nothing surfaced it unless the author thought to
   *  look. So this is deliberately NOT an error: `success` and `errors[]` are
   *  untouched, and a host renders "3 of 12 items failed" from the counts.
   *
   *  ⚠ Both numbers, not a ratio and not just the failures: a surface that had
   *  to re-derive the total from the step result would be reading a 16 KB array
   *  to print one line, and an empty collection (0 of 0) is a different thing
   *  from a collection that all failed. */
  foreach?: {
    /** Iterations attempted — the resolved collection's length. */
    items: number;
    /** Iterations whose inner step reported an error. */
    failed: number;
  };
}

/** What executeRecipe() returns. */
export interface ExecutionResult {
  recipe_id: string;
  /** Stable FNV-1a 32-bit hash of the canonical recipe form. Identifies
   *  the exact recipe version that was executed — use it as a cache key
   *  to avoid re-running when the recipe hasn't changed. Two structurally
   *  identical recipes with different key ordering hash the same. */
  recipe_hash: string;
  /** True when the recipe ran to completion with no errors. False on any
   *  error (which also stops execution immediately — no retries, no
   *  continuation past errors). Zero-retry policy: the user decides when
   *  to re-run, manually.
   *
   *  D-115: when `trigger_skipped` is true, `success` is also true —
   *  a silent-skip is not an error. Callers that distinguish
   *  scheduler outcomes (`success` / `skipped` / `failed`) must read
   *  `trigger_skipped` first, then fall back to `success`. */
  success: boolean;
  /** Render blocks emitted by the recipe's `output.render` config.
   *  `sidebar` is retained as a migration mirror for existing callers.
   *  Each block always carries a `type` discriminator and a `data`
   *  payload; specific block types layer on additional fields (e.g.
   *  `label` on copyable/timestamp, `source` on text blocks). The
   *  index signature keeps those extras typed-as-unknown without
   *  forcing each block kind into the union here. */
  output: {
    render: ResolvedOutputSection[];
    sidebar: ResolvedOutputSection[];
  };
  steps: StepLog[];
  errors: RecipeError[];
  duration_ms: number;
  /** Post-execution observability degradation. These reasons do not
   *  mean the recipe failed; they mean the host could not fully record
   *  audit/provenance after side effects had already happened. */
  degraded?: RunDegradation[];
  /** Populated only when `ctx.strict` was true and the recipe failed
   *  preflight validation. Lists every error-severity issue that caused
   *  the short-circuit. Empty array otherwise. */
  validation_issues: ValidationIssue[];
  /** D-115 Phase 5 — true when the recipe's `trigger_steps` phase
   *  returned `should_run: false` for at least one step, short-
   *  circuiting the tick before prefetch. Silent-skip semantics:
   *  prefetch + steps never run, no output render is emitted, no audit
   *  entry should be written. Callers (runtime / scheduler) use this
   *  to classify the outcome as `skipped` for the circuit-breaker
   *  counter. Only ever set on reactive runs — trigger_steps never
   *  run on manual / cron recipes. */
  trigger_skipped?: boolean;
  /** The step whose `stop_when` ended the run early. The run is a SUCCESS —
   *  there was nothing more to do, so the steps after it did not run — and it
   *  is terminal like any finished one: the output renders from the steps that
   *  ran, and an `output.exchange` still fires (D-232 § 19 — a reply is owed).
   *  Unlike `trigger_skipped`, work DID happen: the steps up to this one ran and
   *  their results are the answer. Absent when the run went to the end. */
  stopped?: { step_id: string; condition: string | Condition };
  /** D-232 § 19.3 — the receipt for an exchange this run FIRED. Present iff the
   *  run declared `output.exchange` and the fire succeeded (or was durably
   *  queued behind an owner's card, which is an acceptance too — the answer is
   *  going).
   *
   *  ⛔ THE ONE THING THE EXCHANGE EXISTS TO PROVIDE. A sender expects nothing
   *  back — that is what makes it a post office and not an RPC — and the single
   *  thing this substrate adds over a real letter is that the sender can ASK
   *  WHAT HAPPENED TO IT. The ref is what they ask about, so a fire that reached
   *  the wire while the caller got no ref would be a letter posted into a system
   *  that cannot be queried: the exchange with its only justification removed.
   *
   *  Engine-derived, never authored (`acknowledgementFor`), so no recipe can
   *  forget it. Absent on a run that renders, a run that paused before the
   *  terminus, and a fire that could not happen — the last of which fails the
   *  run, so an absent ack is never silent. */
  exchange_ack?: ExchangeAcknowledgement;
  /** D-232 § 30 — what the PEER said when the carrier delivered, validated off
   *  the wire. Present only on a fire whose synchronous response carried an
   *  acknowledgement — so: a remote delivery, to a correspondent that answered.
   *
   *  ⛔⛔ THE FIELD IS SEPARATE FROM {@link exchange_ack} ON PURPOSE, AND MERGING
   *  THEM WOULD RE-CREATE THE BUG IT FIXES. `exchange_ack` is OUR receipt — did
   *  our letter go — and on this path it is `accepted: true`, correctly. This is
   *  THEIRS: did their reply go. Both are filed under one ref (both servers do,
   *  by design), and one field cannot hold two servers' answers to two different
   *  questions. The § 29 lie was exactly that shape one layer down: an ack whose
   *  presence was read as a delivery claim.
   *
   *  ⚠ Absent on a LOCAL fire (nothing crossed a wire), on a fire that failed
   *  (the throw path attaches `exchange_ack` with `accepted: false` instead), and
   *  on every peer that returns no receipt — which today is every non-Recued
   *  correspondent. Absence therefore means "they said nothing", never "they said
   *  it was fine". */
  exchange_peer_ack?: ExchangeAcknowledgement;
  /** Host-derived contract bound to the outbound connection used by an
   *  exchange. Kept separate from the wire acknowledgement. */
  exchange_expected_contract_id?: string;
  /** D-115 Phase 5 — dynamic-interval override the recipe wrote via a
   *  step with id `next_run_at`. The engine reads
   *  `stores.step.next_run_at` after all sequential steps finish; when
   *  it resolves to a finite positive number, the value is surfaced
   *  here for the scheduler's `markFinished` nextRunHint. Authors opt
   *  into this path via `auto_run.dynamic: true`; static-interval
   *  recipes simply omit the step and leave this undefined. */
  next_run_at?: number;
  /** D-157 P1 slice 3 — preflight pause outcome. Populated when an
   *  `ingredientExecutor` threw `PreflightRequiredSignal` during the
   *  run: the engine snapshots `step.*` at the gate, ends the
   *  execution, and reports the snapshot here for the host to mint +
   *  persist a `Checkpoint` (D-157 § A.2). `success` is `false` on a
   *  paused run — the run did not complete — and `errors` is empty.
   *  Consumers distinguishing "paused" from "failed" must check
   *  `awaiting_approval` before falling back to `success`.
   *
   *  `step_state` is a structured clone — the host can pass it
   *  straight through to `CheckpointStore.write` without further
   *  defensive copying. */
  awaiting_approval?: {
    preapproval_nested_wait?: { child_run_id: string };
    execution_phase?: 'trigger' | 'prefetch' | 'sequential';
    trigger_state?: Record<string, unknown>;
    prefetch_completed?: string[];
    /** Id of the step whose call drew the `ask` verdict — the
     *  `Checkpoint.gated_step_id`. Resume starts AT this step
     *  (`ExecutionContext.resumeFrom.gated_step_id`). */
    gated_step_id: string;
    /** Cloned snapshot of `ctx.stores.step` at the moment the gate
     *  fired — the `Checkpoint.step_state`. Carries outputs for every
     *  step that completed before the gate; empty `{}` when the gate
     *  fires before any sequential step has produced output (e.g. the
     *  first step in the recipe gates). */
    step_state: Record<string, unknown>;
    /** Completed foreach items plus the exact paused index, when applicable. */
    foreach_progress?: ForeachCheckpointProgress;
    /** D-157 server-wiring — gateway-attached structured fields read
     *  off the caught `PreflightRequiredSignal`. Surfaced verbatim so
     *  the host can populate `PreflightAskContext` and the
     *  `notification.ask` body shows the structured reason ("approve
     *  write `mail.send`"). Absent on legacy raise sites that supplied
     *  only a message — the host falls back to a bare ask in that
     *  case. */
    tool_slug?: string;
    risk_tier?: string;
    reason?: string;
    /** D-165 follow-on (op-identity binding) — the resolved identity of the
     *  gated call, read off the caught `PreflightRequiredSignal`. The host
     *  persists these onto `Checkpoint.approved_target` so resume can verify
     *  the re-resolved call still targets the same operation before honoring
     *  the approval (catalog gate sets all three; the simple-form gate only
     *  `ingredient_slug`). Absent on legacy raise sites. */
    ingredient_slug?: string;
    operation_id?: string;
    connection_name?: string;
    /** D-177 P5a (N.10) — the held call's P1b action-identity hashes +
     *  resolved-args preview, read off the caught signal. The host uses
     *  them to register the hold as a batch-ask member (hash = the
     *  member's identity in the eventual `grant_mode: 'batch'` mint;
     *  preview → the reviewable item summary). Absent when the payload
     *  could not canonicalize — such a hold falls back to a per-hold
     *  ask. */
    arg_shape_hash?: string;
    canonical_payload_hash?: string;
    args_preview?: Record<string, unknown>;
    /** D-177 P5b (N.11) — the held call's open-projection pinned/varies
     *  summary, read off the caught signal. PRESENCE is the host's
     *  `grant_mode: 'open'` offer-feasibility marker (the Gateway's walk
     *  classified this very dispatch); the lines render in the ask body.
     *  Human-facing only — the agent projection never carries it
     *  (N.9.1). */
    open_projection_preview?: {
      pinned: ReadonlyArray<{ label: string; value: string }>;
      varying: ReadonlyArray<{ label: string; origin: string }>;
    };
    /** D-202 Slice 1b — the quality-relevance marker read off the caught
     *  `PreflightRequiredSignal`. `true` iff the commit Gateway raised this ask
     *  as `quality_not_delegated` (authorization admitted; only the missing
     *  quality delegation held the send). The host persists it as
     *  `Checkpoint.quality_relevant`; the answer-path resumer then records one
     *  `QualityDelegationSignal` per resolution. Absent on non-quality asks ⇒ no
     *  signal (behaviour-preserving). */
    quality_relevant?: boolean;
    /** D-217 § 6.1 — the AMPLIFICATION BOUND of a multi-request act, read off
     *  the caught signal. One approval buying N requests is the fact a reviewer
     *  must see BEFORE approving, and it is the one thing an ask naming only
     *  the operation cannot convey. Fixed before the first dispatch (§ 8a), so
     *  it is exact rather than an estimate. Absent on single-request holds. */
    egress_bound?: { readonly requests: number; readonly total_bytes: number };
    /** D-211 — optional standing owner-ruling action + clamp warning. */
    owner_override_offer?: PreflightOverrideOffer;
    approval_clamped_from?: OperationApproval;
    /** D-209 §1.7 — authorization posture before review/quality lifts. */
    authorization_provenance?: AuthorizationProvenance;
    /** § 7 follow-on (pii-ledger-in-checkpoint) — the run's serialized
     *  `PiiLedgerStore` at the gate, present ONLY when the run minted
     *  pii-protect ledgers (authored or auto-synthesized brackets). The
     *  host persists it verbatim as `Checkpoint.pii_ledgers`; resume
     *  threads it back via `resumeFrom.pii_ledgers` and the engine
     *  hydrates its run store from it. Deep-copied like `step_state` —
     *  safe to pass straight to `CheckpointStore.write`. */
    pii_ledgers?: PiiLedgerStoreSnapshot;
  };
  /** D-234 § 234.4 — THE RUN PAUSED WAITING FOR A PEER'S OWNER TO ANSWER.
   *
   *  Structurally the twin of {@link ExecutionResult.awaiting_approval}: the run
   *  did not complete (`success: false`, empty `errors`), the host mints and
   *  persists a `Checkpoint` from `step_state`, and resume re-instantiates with
   *  `resumeFrom.gated_step_id`. A peer answer IS an approval hold whose
   *  answerer is elsewhere.
   *
   *  ⛔⛔ A SEPARATE FIELD, NOT A FLAG ON `awaiting_approval`, FOR THE SAME REASON
   *  `awaiting_peer` IS A SEPARATE `commit_status`. Every consumer that reads
   *  `awaiting_approval` today goes on to raise or pair a LOCAL ask — and this
   *  hold has none to raise. A consumer that does not know the flag would raise
   *  an approval nobody can answer; one that does not know the FIELD does nothing
   *  at all, which is the harmless direction.
   *
   *  ⛔ AND NOTHING RESUMES THIS FROM HERE. The op-step re-runs on resume and
   *  finds the recorded answer, exactly as § 234.1's ceiling re-runs and finds
   *  the recorded admission decision — idempotent-with-memory, both of them. So
   *  the engine needs no answer-injection path and the checkpoint carries no
   *  answer slot. */
  awaiting_peer?: {
    execution_phase?: 'trigger' | 'prefetch' | 'sequential';
    trigger_state?: Record<string, unknown>;
    prefetch_completed?: string[];
    /** Id of the peer-ask step — the `Checkpoint.gated_step_id`. */
    gated_step_id: string;
    /** Cloned snapshot of `ctx.stores.step` at the pause. */
    step_state: Record<string, unknown>;
    /** Completed foreach items plus the exact paused index, when applicable. */
    foreach_progress?: ForeachCheckpointProgress;
    /** Run-local PII alias ledger snapshot. The host persists this verbatim on
     * the peer checkpoint so a later answer can restore aliases safely. */
    pii_ledgers?: PiiLedgerStoreSnapshot;
    /** The conversation id the answer will correlate on. Deterministic, minted
     *  by the op so a re-run of the same step in the same run reproduces it. */
    exchange_ref: string;
    /** What to send, verbatim from the authored step — the host owns delivery. */
    spec: PeerAskSpec;
  };
}
