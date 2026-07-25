import type { Condition } from './conditions.js';
import type { PreflightApprovedTarget } from './checkpoint.js';
import type { Actor, ExecutionSource } from './commits.js';

export type StepType = 'transform' | 'ingredient' | 'guard' | 'unknown';

/** Step-level cache freshness mode.
 *
 *  - `fresh`: always re-fetch. Cache is neither read nor written. Use when
 *    the step must reflect real-time state (e.g. feed path of a write action).
 *  - `acceptable` (default): use cache if within TTL. Standard behavior.
 *  - `any`: use any cached entry regardless of TTL. Enables progressive render:
 *    the sidebar can paint stale data immediately, then a background refresh
 *    re-runs expired steps and updates the UI when fresh values arrive.
 */
export type CacheFreshness = 'fresh' | 'acceptable' | 'any';

/** Per-call options the engine passes through the IngredientExecutor chain.
 *  Derived from the step definition; cache wrappers + dispatch adapters
 *  inspect it. Always optional — omitting it means defaults apply. */
export interface StepOptions {
  /** Step-level cache freshness override. Falls through to the default
   *  policy when omitted. */
  cache?: CacheFreshness;
}

/** Per-call step metadata the engine threads through the IngredientExecutor
 *  chain. D-113 uses it to attribute pending approvals back to the
 *  originating step and to honour step-level `timeout_ms` + `on_timeout`
 *  fields. Middleware that doesn't care (cache, dispatch) forwards it
 *  unchanged. */
export interface StepMeta {
  /** The recipe step's `id` field. Threaded so approval pending records
   *  carry the originating step_id. */
  step_id: string;
  /** Originating recipe id. D-127 follow-on plumbs this so kernel
   *  storage adapters that emit per-call audit rows (`mail_send`) can
   *  attribute the row back to the recipe + step that triggered it.
   *  Optional because direct-rpc callers (Settings → Connections, MCP
   *  agent, tests) reach the underlying collection without going
   *  through the engine — the audit row simply omits both fields in
   *  that case. */
  recipe_id?: string;
  /** D-181 slice 4 — the execution-request anchor `run_id` for this run,
   *  threaded so the long-op live-control substrate can map a running heavy
   *  call (a `service` subprocess) back to its run: the cli executor
   *  registers its SIGKILL handle keyed by `run_id` so `execution.kill` can
   *  reach the child. Engine-set only (forwarded from `ExecutionContext.
   *  run_id` via `buildStepMeta`; `buildStepMeta` never copies arbitrary
   *  step fields). Absent on direct-rpc callers / dbless tests with no run
   *  context — the executor then registers no kill handle (nothing to kill
   *  through the registry). */
  run_id?: string;
  /** D-128 P6 — platform-reference scope this call is operating
   *  against. Stamped by the reconciliation harness + vendor Ds (D-129+)
   *  when invoking the connection adapter on behalf of an enrichment
   *  scope, so `connection_*` audit rows can be filtered by data scope
   *  for forensic queries ("show every HubSpot deal API call"). Shape is
   *  the four-segment `connection.api.<vendor>.<entity>` form; closed-
   *  list scope strings (`mail` / `contact` / …) are also accepted but
   *  ignored at the audit emitter (the connection-call surface is the
   *  only consumer today). Optional — direct-rpc callers + non-vendor
   *  recipe paths leave it absent and the audit row simply omits the
   *  scope field. */
  platform_scope?: string;
  /** Approval timeout for this step (ms). Falls through to the approval
   *  wrapper's execution-mode defaults when omitted. */
  timeout_ms?: number;
  /** Approval timeout policy. Defaults to `fail` at the approval wrapper. */
  on_timeout?: 'fail' | 'approve' | 'reject';
  /** Human-readable approval prompt. Defaults to slug + recipe_id. */
  prompt?: string;
  /** D-136 P7.E — origin of the recipe execution. Threaded so kernel
   *  storage adapters that surface enrichment data (e.g. `enrichment-list`)
   *  can apply policy gates such as `mcp_exposed: 'private'` when the
   *  triggering channel is the MCP consumer surface. Closed list mirrors
   *  `ExecuteRequest.trigger_source` (extension surfaces forward strings
   *  like `'manual'` / `'auto_run'` / `'reactive'` / `'cron'` / `'mcp'`).
   *  Optional — direct-rpc callers without a recipe context leave it
   *  absent. */
  trigger_source?: string;
  /** D-161 P1 — the actor identity driving this execution
   *  (`execution_source.actor`), threaded so kernel write-handlers
   *  (`enrichment-upsert`, `data-annotate`, `data-link`) can stamp the
   *  D-161 `origin_actor` provenance facet on the rows they write —
   *  propagated from the run's `ExecutionSource`, never re-derived (I-6).
   *  Mirrors `trigger_source` above: the engine forwards `ctx.actor`
   *  through `buildStepMeta`; kernel adapters forward it onto the
   *  dispatch input. Absent on dispatch paths that carry no
   *  `execution_source` (legacy direct-rpc, dbless tests) — the
   *  write-handler then defaults the facet to `'system'` (the
   *  conservative engine-internal origin). */
  actor?: Actor;
  /** D-161 P1 — the contract in force on this execution, when contracted
   *  (`executionSourceContractId(execution_source)`). Threaded alongside
   *  `actor` so the write-handler can stamp `origin_contract_id` exactly
   *  when the source carried a `contract_id` (N.4). Absent for an
   *  unrestricted `user_self` / `system` / `anonymous` run. */
  contract_id?: string;
  /** D-192 baseline-admission (S2) — the run's FULL `ExecutionSource`, forwarded
   *  from `ExecutionContext` through `buildStepMeta`. The `actor` + `contract_id`
   *  above are a projection of it; the full source is threaded so a kernel
   *  work-entity create adapter can compute the actor-aware CONTRACT-GRANT admission
   *  (`opAdmissionGate.isOpGranted` needs `actor` + `channel` + the explicit
   *  `contract_id` — the channel distinguishes the owner's AI from the owner's direct
   *  HID, which owner-tightening depends on). Propagated verbatim, never re-derived
   *  (I-6); the create adapter's `withCreateOrigin` forwards it as
   *  `origin_execution_source` (stripping any recipe-supplied value → unforgeable).
   *  Absent on dispatch paths carrying no `execution_source` (dbless / legacy) → the
   *  create degrades on `ask` as before. */
  execution_source?: ExecutionSource;
  /** D-192 6c.2c — this run's work-entity VENDOR writes were pre-approved
   *  by a create-plan / container-pick confirm (the "ONE plan + ONE
   *  confirm covers the WHOLE plan — container create(s) + the pending
   *  write" contract). Engine-set (forwarded from `ExecutionContext`
   *  through `buildStepMeta`) so it is UNFORGEABLE by recipe JSON — the
   *  two re-run wirings are the only producers. Kernel work-entity create
   *  adapters forward it onto the dispatch input (via `withCreateOrigin`,
   *  which strips any recipe-supplied value first); the write executor
   *  converts it to `preflight_admitted` on the vendor create so the
   *  standalone gated spine admits past the op's `'ask'` verdict instead
   *  of degrading to a policy fail (it has no pause path). `ask`→admit
   *  only — never a `'deny'` bypass. Absent on every normal / chat / MCP /
   *  recipe run: those writes gate exactly as before. */
  work_entity_write_preadmitted?: boolean;
  /** D-157 P1 slice 4 — preflight approval was granted upstream for
   *  THIS step. Set by the engine on resume for the step the checkpoint
   *  was minted at (`ctx.resumeFrom.gated_step_id`) so the gateway's
   *  per-call admission probe admits a fresh `'ask'` verdict on the
   *  same boundary-crossing call. Without this, the gated step's
   *  dispatch on resume would re-fire the probe → re-pause → infinite
   *  loop (TR-5 — the spec's "continues PAST the gate" invariant).
   *
   *  Narrow by design: only `'ask'` verdicts are converted to admit;
   *  `'deny'` still fails the call. A policy mutated between pause and
   *  resume that now hard-denies the same tool still blocks; the
   *  approval is for the original `'ask'` decision, not a blanket
   *  bypass. Optional + absent on fresh runs + every non-gated step on
   *  resume.
   *
   *  Spec: D-157 § A.2 step 5 / I-6 / TR-5. */
  preflight_admitted?: boolean;
  /** D-165 follow-on (op-identity binding) — the identity the user approved
   *  at the gate, threaded from `Checkpoint.approved_target` via
   *  `ExecutionContext.resumeFrom`. The engine sets it ALONGSIDE
   *  `preflight_admitted` on the resumed gated step only. The catalog gate
   *  honors `preflight_admitted` only when the re-resolved `(ingredient_slug,
   *  operation_id, connection_name)` matches this — a drifted call re-raises
   *  a fresh ask (fail closed). Absent on fresh runs + non-gated steps.
   *
   *  Spec: D-157 § A.2 step 5 / I-6 / TR-5. */
  preflight_approved_target?: PreflightApprovedTarget;
  /** D-177 P3 — the `allow_session` answer's mint instruction, threaded from
   *  the consumed checkpoint resume (`ExecutionContext.resumeFrom.
   *  session_grant`). The engine sets it ALONGSIDE `preflight_admitted` on the
   *  resumed gated step only, and ONLY when the preflight ask was answered
   *  `allow_session` (a plain `approve` resume never carries it). The commit
   *  Gateway — at the resume-admitted ask-branch — mints a session grant from
   *  the resume dispatch's OWN envelope (slug / op key / resolved connection /
   *  risk tier / P1b hashes), which is computed from the merged resolved args:
   *  that is the D9 "mint from the merged args" basis, produced by the same
   *  code path future dispatches are matched against (N.4). Carries the
   *  TTL / use bounds the ask offered (N.5 — interim chat-seed values until
   *  the P4 cell vocabulary) plus the OFFERED tier (codex HIGH fold): the
   *  Gateway mints only when the resume decision's tier equals it — a
   *  policy/manifest mutation that re-classifies the call mid-ask skips the
   *  mint rather than pinning a tier the human never saw. Engine-set only
   *  (`buildStepMeta` never copies arbitrary step fields — a recipe cannot
   *  forge it); stripped before the inner executor like the sibling resume
   *  markers.
   *
   *  D-177 P5b (N.11) — `grant_mode` rides the same instruction: `'open'`
   *  makes the Gateway mint the provenance-pinned grant (recomputing the
   *  open projection from the resume dispatch's own merged args — the D9
   *  basis); absent/`'exact'`/unrecognized mints the P3 exact-hash grant
   *  (degrading STRICTER, never looser — exact pins the full payload).
   *
   *  Spec: D-177 § N.5 / N.11 / D9; landing order P3 + P5b. */
  preflight_session_grant?: {
    ttl_ms: number;
    max_uses: number;
    risk_tier: string;
    grant_mode?: string;
  };
  /** D-177 P5a (N.10) — the batched approval's member-claim instruction,
   *  threaded from the consumed checkpoint resume
   *  (`ExecutionContext.resumeFrom.batch_claim`). The engine sets it
   *  ALONGSIDE `preflight_admitted` on the resumed gated step only, and only
   *  when the resume came from a batched approve (the batch answer flow is
   *  the sole writer — never caller / channel / context input). At the
   *  dispatch proceed point the commit Gateway atomically CLAIMS this
   *  member of the `grant_mode: 'batch'` grant (consumed_at stamp +
   *  `uses_remaining` decrement in one synchronous write) — the claim IS
   *  the consumption (N.4): a member already claimed (an agent replay won
   *  the race) re-holds the dispatch, so total executions never exceed the
   *  approved member count. Idempotent PER RUN at the host hooks (a
   *  `foreach` gated step re-dispatches per iteration with the same
   *  marker; one member covers the whole gated step exactly as one
   *  approval does today). Engine-set only (`buildStepMeta` never copies
   *  arbitrary step fields); stripped before the inner executor like the
   *  sibling resume markers.
   *
   *  Spec: D-177 § N.10 / N.4; landing order P5a. */
  preflight_batch_claim?: { contract_id: string; member_id: string };
  /** D-165 RUNTIME — trusted surface-dispatch marker. Set by the catalog
   *  gateway when it dispatches a catalog operation over its `surfaces.api`
   *  REST binding through `ctx.ingredientExecutor`. The binding's `method` /
   *  `path` are catalog-validated (trusted), not recipe input — so the
   *  executor skips its D-112 locked-key strip for this dispatch; otherwise the
   *  trusted `method` (an `ENGINE_LOCKED_INPUT_KEY`) would be filtered out. The
   *  gateway has ALREADY stripped locked keys from the recipe-supplied `args`
   *  before adding the binding's method/path, so the D-112 guard against
   *  recipe-injected method/url/auth-headers is preserved. Engine-set only
   *  (`buildStepMeta` never copies arbitrary step fields), so a recipe cannot
   *  forge it. Absent on every non-gateway dispatch. */
  surface_dispatch?: boolean;
  /** D-177 P1b — the SHORT operation key (the `manifest.operations` map
   *  index, e.g. `deal.read`) of the catalog operation this surface dispatch
   *  executes. Set strictly by the catalog gateway ALONGSIDE
   *  `surface_dispatch` (same trust story — `buildStepMeta` never copies it
   *  from recipe JSON, so a recipe cannot forge it), and honored by the
   *  commit Gateway ONLY when `surface_dispatch === true`. The commit
   *  Gateway uses it to resolve the op-level `hash_exclude_args` for the
   *  call's `canonical_payload_hash` — the surface-dispatch wire input
   *  carries no `operation` field, so without this thread the op row is
   *  unreachable at the commit boundary. Absent on every non-catalog
   *  dispatch. */
  surface_operation_key?: string;
  /** D-201 Slice 6B3 — engine-private pre-injection wire input for a catalog
   * surface whose final provider dispatch contains trusted sensitive values.
   * The commit Gateway uses this value for admission, action identity, usage,
   * and pending-commit args, then strips it before the connection adapter. It
   * is honored only with `surface_dispatch === true` and is never copied from
   * recipe JSON. */
  surface_dispatch_authority_input?: Readonly<Record<string, unknown>>;
  /** D-201 Slice 6B3 — the actual surface input/result may contain a trusted
   * callback value. The commit Gateway omits the raw result, and the connection
   * adapter emits only a generic transport-error message. Engine-set only and
   * honored only with `surface_dispatch === true`. */
  surface_dispatch_sensitive?: true;
}

export interface BaseStep {
  id: string;
  skip_when?: string | Condition;
  fail_on?: string | Condition;
  /** Cache freshness mode for this step. Defaults to 'acceptable'.
   *  Honoured by both cache tiers — the L1 ingredient cache (ingredient
   *  + prefetch steps) and the L2 step cache (every sequential step,
   *  including the content-addressable transform / guard entries).
   *  `fresh` bypasses both. */
  cache?: CacheFreshness;
}

/** Transform params are flat on the step object (D-024). */
export type TransformStep = BaseStep & { transform: string } & Record<string, unknown>;

export interface IngredientStep extends BaseStep {
  ingredient: string;
  /** Catalog-form dispatch only: the connection (instance) the catalog
   *  operation runs against. Read top-level by the engine
   *  (`step-runner`: `s.connection ?? input.connection`); the connection-
   *  agnostic install-time rewrite emits the bound connection here. Omitted
   *  on non-catalog ingredient steps. */
  connection?: string;
  input?: Record<string, unknown>;
  /** Step-level output mapping — merged with the ingredient manifest's
   *  default output. Step entries win on key collision. Allows recipes to
   *  map additional or custom response fields without forking the ingredient. */
  output?: Record<string, string>;
  optional?: boolean;
  /** D-103 step-level iteration — re-dispatch this step once per element of the
   *  resolved array (a `{{step.*}}` / `{{config.*}}` ref), binding each element to
   *  `{{item.*}}`. The engine collects per-iteration `{ ok, result, item }` envelopes
   *  (`runForeach`). Read off the step dynamically by the engine; typed here so the
   *  connection-agnostic resolver can carry it onto the concrete fetch it emits for a
   *  TOOL op-step (the single-step pass-through path). */
  foreach?: string;
  /** PII field names to hash before sending to the ingredient and restore after.
   *  Shorthand for hash_replace → ingredient → hash_restore.
   *  Only meaningful on AI ingredients — ignored on data/action ingredients.
   *  Omit to send data as-is (manual hash_replace/hash_restore still works). */
  pii_fields?: string[];
  /** Ingredient version this step was built against. Set automatically by
   *  the Kitchen when adding from marketplace. Used to detect breaking
   *  changes when the marketplace version advances past min_version. */
  ingredient_version?: number;
  /** D-113: approval timeout (ms) for write/admin/destructive ingredients or
   *  the dedicated `require-approval` step. When gossip mode is active, the
   *  executor emits `executor_timeout` at `created_at + timeout_ms`; peers
   *  take over after OWNER_GRACE_WINDOW_MS if the initiator is silent.
   *  When omitted, the approval wrapper picks a default based on execution
   *  mode (interactive: 15m, scheduled: 5m). Ignored on read / AI tiers. */
  timeout_ms?: number;
  /** D-113: how an expired approval resolves. `fail` raises
   *  ApprovalTimeoutError, `approve` executes the ingredient, `reject`
   *  raises ApprovalDeniedError. Defaults to `fail`. */
  on_timeout?: 'fail' | 'approve' | 'reject';
  /** D-113: human-readable prompt shown on every approval surface
   *  (extension, Slack, Telegram, email). Defaults to a generic
   *  "{slug} requested by recipe {recipe_id}" string. */
  prompt?: string;
}

export interface GuardStep extends BaseStep {
  guard: string;
}

/** Connection-agnostic canonical op-step. Addresses a CRM operation by
 *  canonical `<crm_alias-entity>.<verb>` (e.g. `deal.search`) with NO concrete
 *  ingredient or connection — it binds at install to whichever CRM-conformant
 *  pack the recipe lands in. The install-time resolver
 *  (`resolveConnectionAgnosticRecipe` in `@recued/recipes`, the R1 rewrite)
 *  expands every op-step into a concrete catalog fetch + a canonical-field
 *  projection step BEFORE the engine runs, so the engine never executes an
 *  op-step directly. Portable across conforming packs; the op namespace is the
 *  trust-tier discriminator (an all-entity-op recipe is pure-workflow). */
export interface CanonicalOpStep extends BaseStep {
  /** `<canonical-entity>.<verb>` — the entity is a `crm_alias`
   *  (`deal`/`contact`/`account`), the verb a canonical CRM verb
   *  (`read`/`search`/`create`/`update`/`delete`). e.g. `deal.search`. */
  op: string;
  /** Vendor-neutral args only (NO vendor property names — the resolver derives
   *  the vendor field set from the pack's `entity_fields`). e.g. `{ limit: 200 }`. */
  args?: Record<string, unknown>;
  /** Per-operand connection SLOT (recipe-identity doc §1.3 — connection is
   *  per-operand, not per-run). A pure `{{config.<var>}}` ref naming one of the
   *  recipe's `type:'connection'` variables; the resolver binds THIS op-step's
   *  fetch to that slot, so a multi-operand recipe (compare / move / combine)
   *  declares N connection variables and each op-step names its slot. Never a
   *  literal connection name (non-portable in a published canonical recipe —
   *  fails closed at validate/resolve). Omitted → the pack's bound connection
   *  (composition path), else the recipe's single connection variable. When the
   *  recipe declares MORE than one connection variable, every op-step must name
   *  its slot explicitly (no implicit default — outranks the pack default). */
  connection?: string;
  /** §5 tool-op pack seam — per-iteration dispatch over a source collection,
   *  identical to an ingredient step's `foreach`. SUPPORTED ON TOOL OP-STEPS ONLY
   *  (a `<non-crm_alias>.<verb>` op that resolves to a SINGLE pass-through fetch):
   *  the resolver copies it verbatim onto that one fetch, so the engine iterates the
   *  op like any ingredient and `{{item.*}}` in `args` binds per iteration. A CRM
   *  entity-op decomposes into fetch + projection (two steps), where foreach has no
   *  single target, so the validator REJECTS `foreach` on a crm_alias-family op-step
   *  (`op_step_iteration_unsupported`) rather than silently dropping it. Per-iteration
   *  failures are isolated by `foreach` itself (each yields an `{ ok:false }`
   *  envelope) — an op-step carries NO `optional` knob: `optional` is honored only on
   *  prefetch steps (`execute` halts the sequential loop on any error), and op-steps
   *  are sequential-only, so the validator rejects it (`op_step_optional_unsupported`). */
  foreach?: string;
}

export type RecipeStep = TransformStep | IngredientStep | GuardStep | CanonicalOpStep;

export interface PrefetchStep {
  id: string;
  ingredient: string;
  /** Catalog-form dispatch only: the connection (instance) the catalog
   *  operation runs against. Read top-level by the prefetch runner
   *  (`s.connection ?? input.connection`, the same fallback step-runner uses);
   *  the D-182 op-step lowering emits the bound connection here when it
   *  concretizes a Tier-P prefetch op-step. Omitted on non-catalog prefetch
   *  steps. */
  connection?: string;
  input?: Record<string, unknown>;
  /** Step-level output mapping — merged with ingredient manifest defaults. */
  output?: Record<string, string>;
  optional?: boolean;
  skip_when?: string | Condition;
  fail_on?: string | Condition;
  /** Cache freshness mode for this prefetch step. Defaults to 'acceptable'.
   *  Mirrors BaseStep.cache so prefetch and sequential steps share one knob. */
  cache?: CacheFreshness;
  /** Ingredient version this step was built against. */
  ingredient_version?: number;
}

/** D-182 Slice 4 — the prefetch-phase op-step. A `prefetch_steps` entry may name
 *  an op by its two-tier id (kernel `core.<domain>.<op>` or Tier-P
 *  `<publisher>.<pack>.<operation>`) instead of a concrete `ingredient`, the same
 *  way a `steps` entry does — but ONLY for ops that lower to a SINGLE fetch:
 *  kernel closed-kind reads and Tier-P vendor RAW reads ("read ops in prefetch —
 *  that is what it is designed for"). A canonical-convention op (`core.crm.*` /
 *  `core.acct.*`) — or a legacy bare canonical op (`deal.search`) — decomposes
 *  into a fetch + a projection TRANSFORM, which the ingredient-calls-only prefetch
 *  phase cannot hold, so it is rejected in prefetch and must live in `steps` (use
 *  the vendor's Tier-P raw read for a single prefetch fetch).
 *
 *  The op-step lowering (`lowerOpStepRecipe`, @recued/recipes) concretizes every
 *  prefetch op-step into a `PrefetchStep` BEFORE the engine runs — the engine
 *  never executes a `PrefetchOpStep` directly (mirrors how the sequential `OpStep`
 *  is lowered before `runStep`). Distinct from `OpStep`: a prefetch op-step
 *  honours `optional` (prefetch's per-step error isolation) and carries none of
 *  the sequential-only knobs (`foreach` / `pii_fields` / approval timeout). */
export interface PrefetchOpStep {
  id: string;
  /** the two-tier op id — kernel `core.<domain>.<op>` OR Tier-P
   *  `<publisher>.<pack>.<operation>`. A canonical-convention kernel op or a bare
   *  canonical op is rejected in prefetch (it decomposes — must live in `steps`). */
  op: string;
  /** the op's input args, resolved against `{{ref}}`s like any step input. */
  args?: Record<string, unknown>;
  /** per-instance account binding — a pure `{{config.<var>}}` ref — for a Tier-P
   *  `http` / `connection` / `mcp` op; omitted for a kernel op (connection-less). */
  connection?: string;
  /** isolate this prefetch read's failure (mirrors `PrefetchStep.optional`): a
   *  thrown error stores `null` for the step rather than halting the run. */
  optional?: boolean;
  skip_when?: string | Condition;
  fail_on?: string | Condition;
  cache?: CacheFreshness;
}

/** Narrow a `prefetch_steps` entry to a `PrefetchOpStep` (an op-shaped step that
 *  names `op`, not an `ingredient`). Mirrors `isOpStep`: a string `op` and none of
 *  the concrete prefetch discriminants (`ingredient` / `transform` / `guard`), so
 *  a concrete `PrefetchStep` (always carries `ingredient`) is never mistaken for
 *  one. The lowering concretizes these away before the engine runs, so any survivor
 *  at the runner is a bug. */
export const isPrefetchOpStep = (step: unknown): step is PrefetchOpStep => {
  if (step === null || typeof step !== 'object') return false;
  const s = step as Record<string, unknown>;
  return (
    typeof s.op === 'string' &&
    !('ingredient' in s) &&
    !('transform' in s) &&
    !('guard' in s)
  );
};
