/** D-182 §8 step 7 (GRANT HALF) — recipe-less raw catalog-op dispatch.
 *
 *  A Recued MCP door may expose raw catalog ops (Tier-P
 *  `<publisher>.<pack>.<operation>`) to an external LLM WITHOUT a recipe (§8).
 *  This module is the recipe-less dispatch spine the `recued_op_<opid>` MCP
 *  tool route calls: resolve the op id → its installed pack's catalog binding,
 *  §8-fence cli/service, build a recipe-less `ExecutionContext` (the AUDIT HALF
 *  made `ctx.recipe` optional), and route the call through the SAME
 *  `runCatalogOperation` Gateway every recipe op crosses — so audit, policy,
 *  connection-profile authorization, and contract-override tightening all run
 *  their standard paths, just without a recipe wrapper.
 *
 *  Blueprint: `watch/canonical-poll.ts` — a working recipe-less-style direct
 *  `runCatalogOperation` caller. Unlike the poll (a background `actor: 'system'`
 *  read with no approval path), a raw op carries a real EXTERNAL
 *  `ExecutionSource` (the door's `contracted_user`), so the gateway stamps the
 *  op-level audit identity (`execution_source` + `origin_unit_id`) onto every
 *  call and the contract-override scan tightens it per the door's contract.
 *
 *  TWO gates govern a raw op (handover architecture map):
 *    - **Gate A** — the door's per-token tool checklist (`inboundTokenAuthorize`
 *      at the top of `handleToolCall`). Coarse per-wire-tool-name boolean,
 *      default-off. Decides whether `recued_op_<opid>` is callable AT ALL on
 *      this door. Projected by Inc D; runs BEFORE this module.
 *    - **Gate B** — the catalog gateway inside `runCatalogOperation`
 *      (per-operation risk tier + connection-profile grants + `contract.override`
 *      tightening via `ctx.contractScan` + the D-177 session-grant seam). This
 *      module threads the door's actor / source / contract scan onto the ctx so
 *      Gate B evaluates the call under the door's contract.
 *
 *  CONNECTION RESOLUTION (v1 = Model 1): the LLM passes a reserved
 *  `{@link RAW_OP_CONNECTION_ARG}` arg naming the enrolled connection to bind;
 *  this module strips it and passes the remainder as the op args. A
 *  connection-needing op (http / connection / mcp kind) with none fails closed
 *  at the gateway (`no_connection_profile`); an ai / storage op carries none
 *  (`''`). The raw_op GRANT (Inc B) binds the connection from the approved
 *  call's `connection` value, consistent with the grant's connection axis.
 *
 *  Inc A dispatched READS end-to-end with a not-yet-held ask stub (NOT a silent
 *  failure → no weak-model retry loop, per
 *  `[[feedback_substrate_support_inferior_models]]`).
 *
 *  ADMISSION (Inc B-admission, DONE 2026-06-18) — step 4 below applies admission
 *  via the SAME `evaluatePreflightAdmission` primitive `handleExecute` calls
 *  (op-risk × stage-trust approval + the per-tool ACCESS allowlist + the snapshot's
 *  `scope_restrictions` collection fence), the op-admission grant gate layers on
 *  top, and a completed dispatch `recordUse`s the door's usage cap (step 7) — so a
 *  raw op is gated by the owner's contract policy EXACTLY as a recipe op is. This
 *  closes the read-path gap Codex found (a door bypassing the scope fence / op
 *  grant / usage cap) — reads are now owner-policy-safe.
 *
 *  ⚠️ **This block used to say "STILL DEFERRED (Inc B-writes) — a WRITE /
 *  ask-tier op still cannot HOLD on this direct route".** That is no longer
 *  true and the stale text was quoted as evidence for a wrong conclusion
 *  (D-225 § 13.3.1: "door-exposed generated packs are read-only in practice").
 *
 *  Inc B-writes is BUILT AND WIRED. A write / ask-tier op the gate holds is
 *  durably HELD here: a recipe-LESS `Checkpoint` carrying the `raw_op`
 *  discriminant + the D-158 ask, and an `allow_session` answer mints a `raw_op`
 *  grant so the next identical call auto-admits. The hold substrate
 *  (`checkpointStore` / `preflightNotifier` / `sessionGrantResolver`) rides
 *  `deps` (`McpDeps` ⊇ `ExecuteHandlerDeps`) and is composed in
 *  `compose-listeners.ts`.
 *
 *  ⛔ `approvalNotWiredAsk` is the DEGRADED fallback, not the normal path — it
 *  fires only when `checkpointStore` / `preflightNotifier` are absent (a
 *  partial harness / dbless boot). Seeing it in a test does NOT mean writes are
 *  unsupported; it means that harness did not wire the hold substrate.
 *
 *  🔑 Grant and approval are two axes and both apply. The contract grant says
 *  whether this caller may EVER invoke the op; the op's `approval` tier says
 *  whether THIS call proceeds now. `approval: 'never'` + granted ⇒ executes
 *  outright. `approval: 'ask'` + granted ⇒ holds, because a grant that could
 *  silently satisfy an ask would be a second path to auto-run bypassing
 *  `confirm_risk_downgrade`. The owner closes that gap deliberately by
 *  answering `allow_session`.
 */

import { randomUUID } from 'node:crypto';

import type {
  AuthorizationProvenance,
  Checkpoint,
  ContractSnapshot,
  ExecutionSource,
  OperationApproval,
  GatewayCallAudit,
  IngredientManifest,
  PreflightApprovedTarget,
  PreflightRequiredSignal,
  RiskTier,
  SessionGrantOffer,
} from '@recued/contracts';
import {
  deriveDispatchScope,
  executionSourceContractId,
  isDoorDispatchSource,
  executionSourceHasContract,
  isExternallyExposableIngredient,
  isPreflightRequiredSignal,
  parseOpId,
  PlatformRecordIdError,
  QualifiedWorkEntityIdError,
  resolveSessionGrantOffer,
  routePlatformRecordOperationArgs,
  routeQualifiedWorkEntityOperationArgs,
  stampPlatformRecordIds,
} from '@recued/contracts';
import {
  deriveChannelSessionId,
  evaluatePreflightAdmission,
  raisePreflightAsk,
  type PreflightAskContext,
  type PreflightNotifier,
} from '@recued/gateway';
import type {
  CatalogGrantCall,
  CatalogSessionGrantHooks,
  ExecutionContext,
} from '@recued/engine';
import { runCatalogOperation, resolveCatalogRecordsPath } from '@recued/engine';

/** `StepMeta | undefined` — the 8th positional arg of `runCatalogOperation`.
 *  Derived rather than imported because `@recued/engine` does not re-export
 *  `StepMeta` from its index (it is an internal engine type). */
type RawOpStepMeta = Parameters<typeof runCatalogOperation>[7];
import type { CheckpointStore } from '@recued/storage';
import { buildPackOpResolution } from './pack-inventory.js';
import { resolveConnectionVendor } from './storage/connection-store.js';
import type { OpAdmissionGate } from './op-admission-gate.js';
import type { ExecuteHandlerDeps } from './execute-handler.js';
import { connectionBaseUrlFromConfig } from './execute-handler.js';
import { KERNEL_WORK_ENTITY_SOURCE_DECLARATIONS } from './work-entity-source-boot.js';
import {
  evaluateSellerCustomerAccessAdmission,
} from './seller/customer-access-admission.js';
import {
  DIRECT_MCP_TOOL_CALL_BASE_RESERVATION_KEY,
} from './seller/customer-surface-usage.js';
import type { SessionGrantResolver } from './session-grant-resolver.js';
import { remoteFileConnectionNamesIn } from './collections/file/remote-file-byte-resolver.js';
import {
  createBoundExecutor,
  createGatewayAuditEmitter,
  createNamespaceStores,
} from './server-executor.js';

/** The reserved op-args key naming the enrolled connection a raw op binds
 *  (Model 1). Stripped from the op args before dispatch; the Inc D catalog tool
 *  schema advertises it (ideally an enum of the catalog's enrolled
 *  connections). An op arg that genuinely needs a field named `connection`
 *  cannot coexist with raw exposure in v1 — the reservation is the documented
 *  tradeoff of Model 1. */
export const RAW_OP_CONNECTION_ARG = 'connection';

/** The synthetic `StepMeta.step_id` for a recipe-less raw op (there is no
 *  recipe step). Parallels canonical-poll's `'watch_poll'`; rides the audit row
 *  so a raw-op call reads as such. The op identity itself lands on the audit
 *  row's `ingredient_id` / `operation_id` (from the catalog call) + the
 *  `execution_source` / `origin_unit_id` the gateway stamps. */
const RAW_OP_STEP_ID = 'raw_op';

/** The connection surface a raw op dispatches over. Raw-exposable Tier-P
 *  catalogs are `api`-surface (the Tier-3 `connection.mcp` passthroughs are
 *  hidden from the wire + §8-handled), so the contract-admission scope fence
 *  derives a connection-kind catalog's coarse scope as `connection.api` — the
 *  same scope `handleExecute` derives from a resolved connection dispatch. */
const RAW_OP_DISPATCH_CONNECTION_KIND = 'api';

/** The agent-facing message for an op held pending the user's approval, when
 *  the direct (recipe-less) op route can't yet hold it (Inc B-writes lands the
 *  real hold + `raw_op` mint). Shared by BOTH ask sources — the contract
 *  policy_matrix admission AND the catalog gateway's per-op preflight — so the
 *  posture is identical: a held action is the expected outcome (NOT a failure),
 *  route it through a recipe, and do NOT retry (anti-loop, per
 *  `[[feedback_substrate_support_inferior_models]]`). `reason` is the one clause
 *  that differs (which gate asked). */
const approvalNotWiredAsk = (opId: string, reason: string): string =>
  `'${opId}' ${reason}, and approval is not yet available on the direct operation route. `
  + 'Ask the user to run this through a recipe (which can hold for approval), or use a read-only '
  + 'operation instead. Do NOT retry this call.';

/** The fields this module needs off the MCP/execute deps. Picked from
 *  {@link ExecuteHandlerDeps} so the field TYPES stay in lockstep with it —
 *  `McpDeps extends ExecuteHandlerDeps`, so a `McpDeps` satisfies this
 *  structurally and the route passes `deps` straight through. */
export type RawOpDispatchDeps = Pick<
  ExecuteHandlerDeps,
  | 'executorConfig'
  | 'connectionOperationProfiles'
  | 'connectionStore'
  | 'contractScan'
  | 'auditLog'
  // The CAS-ingest sink a read-tier `response_capture` op (e.g. storage-gdrive
  // `file.download`) lands its body through; absent ⇒ the gateway fails such an
  // op closed with `no_file_ingestor`. Threaded so a raw read that captures a
  // file works exactly as the recipe path does.
  | 'ingestFileDownload'
  // The contract-governance resolver. Used to meter the door's usage cap
  // (`shouldMeterUse` + `recordUse` at the proceed point) and to derive the
  // contract's collection read-fence for the snapshot. Absent (stdio / env-var
  // transport) ⇒ no metering + admit-all scope, like `handleExecute`.
  | 'contractOverlay'
  // D-196 seller-customer admission store. Fresh MCP dispatch gates at the
  // transport; resume re-checks here because a held write can outlive the
  // customer's grace window.
  | 'sellerCustomerAdmissionStore'
  // D-196 direct-MCP request-local usage session. Raw catalog dispatch reserves
  // its base unit at the catalog gate's final post-approval proceed hook.
  | 'customerUsage'
  // D-196 R2 — held approvals re-resolve bearer + contract authority at the
  // resumed effect boundary. Optional on the shared deps type because
  // non-resume embeddings need none; a held raw-op resume without it denies.
  | 'approvalResumeAuthority'
  // D-187 AMENDMENT 3b — the op-admission grant gate. A raw op is admission-gated by the
  // unified grant store EXACTLY as a recipe op in `handleExecute`: an explicit `op`
  // revoke on the governing contract denies (`op_not_granted`) even when the
  // snapshot/cell admits. Without this the raw-op path (MCP catalog dispatch + its
  // resume) would be a fail-open hole in the unified grant matrix (codex 3b HIGH). Absent
  // ⇒ no op gate (additive), like `handleExecute`.
  | 'opAdmissionGate'
  // Inc B-writes — the recipe-LESS hold substrate. A write/ask-tier raw op
  // HOLDS for the owner's approval by minting a recipe-less `Checkpoint` (the
  // `raw_op` discriminant) + raising the D-158 ask. Both must be present to
  // hold durably; absent ⇒ the dispatch degrades to the not-wired ask stub
  // (anti-loop, never a silent fail). The session-grant resolver mints the
  // `raw_op` grant on an `allow_session` answer (the resume path).
  | 'checkpointStore'
  | 'preflightNotifier'
  | 'sessionGrantResolver'
  | 'gatedActionStore'
> & {
  /** Test seam — substitute the IO executor UNDER the gateway (mirrors
   *  `CanonicalPollDeps.buildExecutor`): tests script wire responses while the
   *  REAL gateway still resolves policy. Production omits it ⇒ the bound
   *  executor over `executorConfig`, WITHOUT a `recipeContext` so there is no L1
   *  ingredient-cache wrap (raw reads stay fresh, like the poll). */
  buildExecutor?: (
    config: ExecuteHandlerDeps['executorConfig'],
    stores: ReturnType<typeof createNamespaceStores>,
  ) => ReturnType<typeof createBoundExecutor>;
  /** D-166 token↔contract binding kill-switch (mirrors `McpDeps`). When the
   *  inbound token is bound to a contract that is no longer live
   *  (`boundContractId` set + `boundContractActive !== true`),
   *  `buildMcpContractSnapshot` collapses `allowed_tools` to `[]` so the door
   *  authorizes NOTHING. The catalog-slug alias below MUST honor that — it skips
   *  aliasing for a dead bound contract so the kill-switch stands. (McpDeps-only
   *  fields, so declared here rather than Pick'd from ExecuteHandlerDeps.) */
  boundContractId?: string;
  boundContractActive?: boolean;
  /** Test seam — id minter for the recipe-less checkpoint's `checkpoint_id` +
   *  `run_id` (the latter doubles as the `raw_op` grant's `approved_action_ref`).
   *  Production omits it ⇒ `randomUUID`. */
  newId?: () => string;
  /** Test seam — clock for the checkpoint's `created_at`. Production omits it
   *  ⇒ `Date.now`. */
  now?: () => number;
};

/** A raw-op dispatch request. `opId` is the Tier-P op id with the
 *  `recued_op_` wire prefix already stripped; `args` is the LLM-supplied tool
 *  payload INCLUDING the reserved {@link RAW_OP_CONNECTION_ARG}; `executionSource`
 *  is the door's MCP source (`buildMcpExecutionSource(deps)`). */
export interface RawOpDispatchRequest {
  opId: string;
  args: Record<string, unknown>;
  executionSource: ExecutionSource;
  /** Inc B-admission — the per-token contract snapshot the route builds via
   *  `buildMcpContractSnapshot(executionSource, deps)`. REQUIRED for a
   *  contract-bearing source (every door / mcp source carries a `contract_id`):
   *  `evaluatePreflightAdmission` THROWS without it (fail-closed, mirroring
   *  `handleExecute`). Optional on the type only for a hypothetical
   *  contract-free caller. */
  contractSnapshot?: ContractSnapshot;
}

/** The outcome of a raw-op dispatch — a discriminated union so the route maps
 *  each case to its MCP envelope without control-flow-by-exception:
 *    - `result`  → `text(projectRunResultForAgent(result))` (a completed read).
 *    - `held`    → `text(HELD_FOR_APPROVAL_MESSAGE)` (Inc B-writes — a write /
 *      ask-tier op durably held for the owner's approval: a `Checkpoint` was
 *      minted + the D-158 ask raised. NOT an error — a held action is the
 *      expected outcome. `run_id` is the hold's durable anchor id.)
 *    - `ask`     → `text({ status: 'requires_approval', … })` (the DEGRADED
 *      stub: an ask-tier op that could NOT be held durably because the hold
 *      substrate is unwired — anti-loop "do not retry" guidance, never a
 *      silent fail).
 *    - `refused` → `err(message)` (a structural refusal: bad id / not installed
 *      / op undeclared / catalog unloaded / §8-fenced / policy deny).
 *  A gateway DENY (e.g. `no_connection_profile`) is THROWN by
 *  `runCatalogOperation` and surfaced by the route's outer catch as `err(...)`. */
export type RawOpDispatchOutcome =
  | { kind: 'result'; result: unknown }
  | { kind: 'held'; op_id: string; run_id: string }
  | { kind: 'ask'; op_id: string; message: string }
  | {
      kind: 'refused';
      message: string;
      /** Two id families refuse here and each keeps its own codes — D-254 kept
       *  the platform-record codes distinct from the work-entity ones so a
       *  reader chasing one is never sent to the other router. */
      code?: QualifiedWorkEntityIdError['code'] | PlatformRecordIdError['code'];
      /** Work-entity refusals only: the tool to retry with. A platform-record
       *  mismatch retries the SAME tool against another connection, which the
       *  message names instead. */
      retry_with?: string;
      expected_source?: string;
      actual_source?: string;
    };

/** Terminal observation produced when an owner answer resumes a raw MCP op.
 * The original implementation returned `void`, which made the exact provider
 * result disappear at the approval boundary. This result is host-only: the
 * PreflightResumer persists it against the originating MCP action reference. */
export type RawOpResumeOutcome =
  | { kind: 'completed'; result: unknown }
  | { kind: 'failed'; code: string; message: string }
  | { kind: 'in_doubt'; code: string; message: string }
  | { kind: 'skipped'; reason: string };

const KERNEL_SOURCE_VENDOR_BY_CATALOG: Readonly<Record<string, string>> = {
  'hubspot-catalog': 'hubspot',
  'salesforce-catalog': 'salesforce',
  'microsoft-todo': 'microsoft',
};

const routingManifestForRawOp = (
  manifest: IngredientManifest,
  catalogSlug: string,
): IngredientManifest => {
  // Pack-carried declarations are authoritative. Append the legacy first-party
  // kernel copies only as a compatibility fallback for installed catalogs that
  // predate the ownership migration; candidate de-duplication keeps the pack
  // copy when both identify the same Source. The
  // binding must name one exact curated catalog: ingredient slugs are not an
  // authority namespace, and prefix inference (`hubspot-*`) would let an
  // unrelated/local catalog borrow HubSpot's Source identity and unwrap its
  // ids. Never infer this from mutable connection vendor metadata either.
  const vendor = KERNEL_SOURCE_VENDOR_BY_CATALOG[catalogSlug];
  const kernel = vendor === undefined
    ? []
    : KERNEL_WORK_ENTITY_SOURCE_DECLARATIONS[vendor] ?? [];
  if (kernel.length === 0) return manifest;
  return {
    ...manifest,
    work_entity_sources: [
      ...(manifest.work_entity_sources ?? []),
      ...kernel,
    ],
  };
};

/** Dispatch a raw catalog op for an external door, recipe-less. Returns a
 *  {@link RawOpDispatchOutcome}; re-throws any non-preflight error from the
 *  gateway (the route's catch maps it to an MCP error envelope). */
export const dispatchRawOp = async (
  deps: RawOpDispatchDeps,
  req: RawOpDispatchRequest,
): Promise<RawOpDispatchOutcome> => {
  const { opId, args, executionSource } = req;

  // 1-3 — resolve the op id → its installed pack's catalog binding + manifest,
  //       §8-fence cli/service (shared with the resume path).
  const resolved = resolveRawOpBinding(deps, opId);
  if (resolved.kind !== 'ok') return { kind: 'refused', message: resolved.message };
  const { binding, manifest, operation } = resolved;

  // 4 — connection resolution (Model 1): strip the reserved `connection` arg;
  //     the remainder are the op args. Done BEFORE admission (Inc B-writes) so a
  //     HELD write freezes the exact op args + connection onto its checkpoint.
  //     A connection-needing op with none fails closed at the gateway
  //     (`no_connection_profile`); ai/storage ops pass ''.
  const { [RAW_OP_CONNECTION_ARG]: connectionRaw, ...rawOpArgs } = args;
  const connectionName = typeof connectionRaw === 'string' ? connectionRaw : '';
  let opArgs: Record<string, unknown>;
  try {
    opArgs = routeQualifiedWorkEntityOperationArgs({
      manifest: routingManifestForRawOp(
        manifest,
        binding.catalog_slug,
      ),
      operation,
      connection_name: connectionName,
      args: rawOpArgs,
    }).args;
  } catch (error) {
    if (error instanceof QualifiedWorkEntityIdError) {
      return {
        kind: 'refused',
        message: error.message,
        code: error.code,
        ...(error.retry_with !== undefined ? { retry_with: error.retry_with } : {}),
        ...(error.expected_source !== undefined
          ? { expected_source: error.expected_source }
          : {}),
        ...(error.actual_source !== undefined
          ? { actual_source: error.actual_source }
          : {}),
      };
    }
    throw error;
  }

  // 4b — D-254 slice 1 — the platform-record id family, unwrapped at the same
  //      point and for the same reason. `routingManifestForRawOp` augments only
  //      `work_entity_sources`, so the binding is read from the manifest's own
  //      `operations` map. No `retry_with`: the retry here is the SAME tool
  //      naming a different connection, not a different tool.
  try {
    opArgs = routePlatformRecordOperationArgs({
      id_arg: manifest.operations?.[operation]?.record_id_arg,
      operation,
      connection_name: connectionName,
      args: opArgs,
    }).args;
  } catch (error) {
    if (error instanceof PlatformRecordIdError) {
      return {
        kind: 'refused',
        message: error.message,
        code: error.code,
        ...(error.expected_source !== undefined
          ? { expected_source: error.expected_source }
          : {}),
        ...(error.actual_source !== undefined
          ? { actual_source: error.actual_source }
          : {}),
      };
    }
    throw error;
  }

  // 5 — contract policy_matrix admission (Inc B-admission) — shared with the
  //     resume path (`admitRawOp`).
  const admission = admitRawOp(deps, {
    binding,
    manifest,
    operation,
    executionSource,
    args: req.args,
    ...(req.contractSnapshot !== undefined ? { contractSnapshot: req.contractSnapshot } : {}),
  });
  if (admission.verdict === 'deny') {
    return {
      kind: 'refused',
      message:
        `'${opId}' is denied by the active contract policy (${admission.detail}). `
        + 'Ask the owner to grant it on this door, or use a permitted operation.',
    };
  }
  if (admission.verdict === 'ask') {
    // Inc B-writes — the contract policy cell escalated this op to approval.
    // HOLD it durably (a recipe-less checkpoint + the D-158 ask). No
    // action-identity hashes are available here (admission runs BEFORE the
    // catalog gate computes them), so an `allow_session` answer cannot mint a
    // `raw_op` grant — it degrades to a plain one-shot approval (no offer).
    return buildRawOpHold(
      deps,
      {
        opId,
        catalogSlug: binding.catalog_slug,
        operation,
        opArgs,
        connectionName,
        executionSource,
        ...(req.contractSnapshot !== undefined
          ? { contractSnapshot: req.contractSnapshot }
          : {}),
      },
      {
        reason: `requires the user's approval under the contract policy (${admission.detail})`,
        risk_tier: manifest.risk_tier,
        authorization_provenance: admission.authorization_provenance,
      },
    );
  }

  // 6 — dispatch through the SAME Gateway every recipe op crosses (FRESH mode:
  //     `catalogSessionGrants` wired so a previously-minted `raw_op` grant
  //     auto-admits the next identical call. Read/write/admin calls can consult
  //     grants, but only pre-lift `never | ask` rulings may match one. The gate
  //     decides admit / ask (`PreflightRequiredSignal`) / deny itself.
  const correlationId =
    executionSource.channel === 'mcp' ? executionSource.tool_call_id : undefined;
  const dispatch = await runRawOpThroughGateway(deps, {
    catalogSlug: binding.catalog_slug,
    manifest,
    operation,
    opArgs,
    connectionName,
    executionSource,
  });
  if (dispatch.kind === 'preflight') {
    // The catalog gateway held this op (a write / ask-tier OP). Build the
    // durable recipe-less hold off the signal's action identity — its hashes
    // make a `raw_op` grant mintable on an `allow_session` answer.
    const sig = dispatch.signal;
    return buildRawOpHold(
      deps,
      {
        opId,
        catalogSlug: binding.catalog_slug,
        operation,
        opArgs,
        connectionName,
        executionSource,
        ...(req.contractSnapshot !== undefined
          ? { contractSnapshot: req.contractSnapshot }
          : {}),
        ...(correlationId !== undefined ? { correlationId } : {}),
      },
      {
        reason: sig.reason ?? "requires the user's approval before it can run",
        risk_tier: sig.risk_tier ?? manifest.risk_tier,
        ...(sig.arg_shape_hash !== undefined ? { arg_shape_hash: sig.arg_shape_hash } : {}),
        ...(sig.canonical_payload_hash !== undefined
          ? { canonical_payload_hash: sig.canonical_payload_hash }
          : {}),
        ...(sig.owner_override_offer !== undefined
          ? { owner_override_offer: sig.owner_override_offer }
          : {}),
        ...(sig.approval_clamped_from !== undefined
          ? { approval_clamped_from: sig.approval_clamped_from }
          : {}),
        ...(sig.authorization_provenance !== undefined
          ? { authorization_provenance: sig.authorization_provenance }
          : {}),
      },
    );
  }
  // D-254 slice 2 — COMPOSE ON THE WAY OUT, at this door only.
  //
  // ⛔ NOT in `runCatalogOperation`. A recipe's connection is fixed by its binding,
  // so the read and the write it feeds are the same account and a bare native id is
  // already unambiguous there — while stamping the gateway would push a Recued
  // storage key into the vendor-shaped payload recipes consume, against D-190 C2
  // (`id` stays a vendor selector), D-206/D-205 ruling 3 (vendor refs stay raw) and
  // the reconciler's own "the projection emits none".
  //
  // 🔑 THIS DOOR IS THE CASE THAT NEEDS IT. Here the caller names the connection
  // PER CALL (`RAW_OP_CONNECTION_ARG`) and supplies the id separately, so nothing
  // stops a model reading from `hubspot1` and then writing with
  // `connection: hubspot2` and that id: a bare native id parses as nothing, falls
  // through, and updates the WRONG ACCOUNT's record 47291. Handing the id back
  // COMPOSED is what lets the write half refuse it.
  //
  // ⛔ The records path comes from the ENGINE's own resolver. Re-deriving it here
  // would agree until a pack declares a per-op `result_path` override and then
  // disagree silently — no ids emitted, indistinguishable from an empty result.
  return {
    kind: 'result',
    result: stampPlatformRecordIds({
      result: dispatch.result,
      vendor: connectionName.length > 0 && deps.connectionStore !== undefined
        ? resolveConnectionVendor(
          deps.connectionStore.get('api', connectionName) ?? { config_json: '' },
        )
        : undefined,
      // The op family IS the entity, registry-checked inside the stamper —
      // `deal.read` → deal. A family that is not a registered entity
      // (`engagement.list`, `deal_contacts.list`) composes nothing.
      entity: operation.split('.')[0] ?? '',
      connection_name: connectionName,
      records_path: resolveCatalogRecordsPath(manifest, operation),
    }),
  };
};

// ────────────────────────────────────────────────────────────────
// Shared internals — resolve + admit (single source of truth for the
// security-critical steps; fresh dispatch AND resume both go through them).
// ────────────────────────────────────────────────────────────────

/** The resolved op binding a raw-op dispatch targets. Only `catalog_slug` is
 *  surfaced — the operation-membership check happens inside
 *  {@link resolveRawOpBinding}; callers dispatch with the resolved `operation`. */
interface ResolvedRawOpBinding {
  binding: { catalog_slug: string };
  manifest: IngredientManifest;
  operation: string;
}

/** Steps 1-3 — parse the Tier-P op id, resolve its installed pack's catalog
 *  binding via the SAME spine the recipe lowering uses, load the manifest, and
 *  §8-fence cli/service (never raw-callable). A kernel id, a malformed id, an
 *  uninstalled pack, an undeclared operation, an unloaded catalog, or a fenced
 *  kind all return a `refused` message; otherwise `ok` with the binding. */
const resolveRawOpBinding = (
  deps: RawOpDispatchDeps,
  opId: string,
): { kind: 'ok' } & ResolvedRawOpBinding | { kind: 'refused'; message: string } => {
  const parsed = parseOpId(opId);
  if (parsed === null || parsed.tier !== 'pack') {
    return {
      kind: 'refused',
      message:
        `'${opId}' is not a valid pack operation id (expected '<publisher>.<pack>.<operation>'). `
        + 'Check the tool catalog for the exact op id.',
    };
  }
  // No installed-pack inventory (dbless / unit) ⇒ nothing resolvable ⇒ refuse.
  if (deps.contractScan === undefined) {
    return {
      kind: 'refused',
      message: `Cannot resolve '${opId}': no installed-pack inventory is available on this server.`,
    };
  }
  const resolution = buildPackOpResolution(
    () => deps.contractScan!('installed_pack', []),
    (slug) => deps.executorConfig.manifests.get(slug),
  );
  const binding = resolution.get(parsed.pack_ref);
  if (binding === undefined) {
    return {
      kind: 'refused',
      message:
        `Pack '${parsed.pack_ref}' is not installed (or declares no operation catalog), so '${opId}' `
        + 'cannot be called. Install the pack first.',
    };
  }
  if (!binding.operations.has(parsed.operation)) {
    return {
      kind: 'refused',
      message:
        `Operation '${parsed.operation}' is not declared by pack '${parsed.pack_ref}'. `
        + 'Check the tool catalog for the operations this pack exposes.',
    };
  }
  const manifest = deps.executorConfig.manifests.get(binding.catalog_slug);
  if (!manifest) {
    return {
      kind: 'refused',
      message: `The catalog ingredient '${binding.catalog_slug}' backing '${opId}' is not loaded on this server.`,
    };
  }
  // §8 KIND fence — a `cli` / `service` ingredient is local code-exec / an
  // external subprocess and is NEVER raw-callable; trigger a recipe that uses
  // it instead. Mirrors the `recued_ingredient_<slug>` route's backstop.
  if (!isExternallyExposableIngredient(manifest)) {
    return {
      kind: 'refused',
      message:
        `'${opId}' resolves to a local-binary (cli) or service ingredient and cannot be called `
        + 'directly over MCP — trigger a recipe that uses it instead '
        + '(D-182 §8: cli/service stay recipe-internal).',
    };
  }
  return { kind: 'ok', binding, manifest, operation: parsed.operation };
};

/** Step 5 — the contract `policy_matrix` admission (Inc B-admission). The SAME
 *  `evaluatePreflightAdmission` primitive `handleExecute` applies per dispatch
 *  (NOT a re-implementation), so a raw op is gated by the door's owner-set
 *  contract policy EXACTLY as a recipe op is: the `(channel × actor × contract)`
 *  cell (deny / `denied_ingredient_ids` / approval escalation) + the snapshot's
 *  `scope_restrictions`. Keyed on the catalog INGREDIENT (slug / kind /
 *  risk_tier) + the coarse dispatch scope; the per-OPERATION risk tier +
 *  connection grants are the catalog gateway's job.
 *
 *  Gate A (the per-token checklist at the top of `handleToolCall`) already
 *  authorized THIS op's wire name (`recued_op_<opid>`) — that IS the door's
 *  per-op grant. But `buildMcpContractSnapshot` builds `allowed_tools` from raw
 *  ingredient slugs + `recued_ingredient_<slug>` aliases only, so the backing
 *  `catalog_slug` is ABSENT for a raw-op grant, and the admission's
 *  tool-allowlist gate would wrongly deny a Gate-A-authorized op as
 *  `tool_not_in_contract`. Alias the catalog_slug in so the allowlist gate
 *  doesn't re-deny it; the op-risk approval + the collection scope fence still
 *  tighten on top. BUT honor the bound-contract KILL-SWITCH: a dead bound
 *  contract collapses `allowed_tools` to `[]` (revoke = live kill-switch), so
 *  skip the alias for a dead contract — admission denies `tool_not_in_contract`
 *  exactly as the recipe path's dead contract does. */
const admitRawOp = (
  deps: RawOpDispatchDeps,
  p: {
    binding: { catalog_slug: string };
    manifest: IngredientManifest;
    // Grant-foundation slice 2a — the raw op's SHORT `operations`-map key,
    // resolved to the DECLARED `operation_id` below (the format a standing
    // contract's `scope.operation_ids` is authored with — codex fold) so the
    // contract overlay can honor a contract scoped to specific ops.
    operation: string;
    executionSource: ExecutionSource;
    contractSnapshot?: ContractSnapshot;
    /** Forwarded to the shared core's connection fence — see its doc. */
    args?: Record<string, unknown>;
  },
): ReturnType<typeof evaluatePreflightAdmission> => {
  const { binding, manifest, operation, executionSource } = p;
  const boundContractDead =
    deps.boundContractId !== undefined && deps.boundContractActive !== true;
  const admissionSnapshot =
    p.contractSnapshot !== undefined
    && !boundContractDead
    && !p.contractSnapshot.allowed_tools.includes(binding.catalog_slug)
      ? {
          ...p.contractSnapshot,
          allowed_tools: [...p.contractSnapshot.allowed_tools, binding.catalog_slug],
        }
      : p.contractSnapshot;
  return admitCatalogOpForSource(deps.opAdmissionGate, {
    ...(p.args !== undefined ? { args: p.args } : {}),
    ...(deps.contractOverlay !== undefined
      ? { admitsConnection: (src, name) => deps.contractOverlay!.admitsConnection(src, name) }
      : {}),
    catalogSlug: binding.catalog_slug,
    manifest,
    operation,
    executionSource,
    ...(admissionSnapshot !== undefined ? { contractSnapshot: admissionSnapshot } : {}),
  });
};

/** The SHARED per-dispatch catalog-op admission core — the checks a
 *  door-governed catalog invocation must pass, in one home so its two
 *  callers can never drift:
 *
 *   1. `evaluatePreflightAdmission` — the contract snapshot's
 *      `allowed_tools` ACCESS gate + the `scope_restrictions` collection
 *      fence + the op-risk × stage-trust APPROVAL probe, keyed on the
 *      catalog INGREDIENT (slug / kind / risk_tier) + the derived
 *      `connection.api` dispatch scope;
 *   2. the D-188 master-pause freeze (governed dispatches halt;
 *      `server_paused`, never a lying `op_not_granted`);
 *   3. the D-187 3b op-admission grant gate (`isOpGranted` on the
 *      DECLARED `operation_id`) — an explicit `op` revoke on the
 *      governing contract (owner or door) denies even when the
 *      snapshot admits.
 *
 *  Callers:
 *   - {@link admitRawOp} (fresh raw-op dispatch + its resume) — with a
 *     PREAMBLE that aliases the backing `catalog_slug` into the
 *     snapshot's `allowed_tools` (Gate A already authorized the
 *     specific op's wire name, which IS the door's per-op grant) unless
 *     the bound contract is dead (kill-switch stands).
 *   - the D-192 work-entity targeted-read escalation seam
 *     (`work-entity-read-tools.ts`) — with the snapshot UNTOUCHED:
 *     a `work.search` / `work.read` wire grant is a MIRROR-read grant,
 *     not a reach-the-vendor grant, so escalation admits only when the
 *     door's contract already allows the backing catalog tool (raw slug
 *     or `recued_ingredient_<slug>` grant → snapshot alias, or a
 *     wildcard/owner door). The dead-contract kill-switch needs no
 *     special casing there: `buildMcpContractSnapshot` collapses a dead
 *     bound contract's `allowed_tools` to `[]`, which this core's
 *     ACCESS gate then denies.
 *
 *  A contract-bearing source WITHOUT a snapshot throws (fail-closed,
 *  `evaluatePreflightAdmission`'s own posture); a contract-FREE source
 *  (owner chat / stdio owner) runs the probe snapshot-less — reads
 *  admit under the owner ceiling and the pause + op-grant layers still
 *  apply (the owner contract is a real, tightenable gate). */
export const admitCatalogOpForSource = (
  opAdmissionGate: Pick<OpAdmissionGate, 'isFrozenByPause' | 'isOpGranted'> | undefined,
  p: {
    catalogSlug: string;
    manifest: IngredientManifest;
    /** The SHORT `operations`-map key; resolved to the DECLARED
     *  `operation_id` for the grant gate below. */
    operation: string;
    executionSource: ExecutionSource;
    contractSnapshot?: ContractSnapshot;
    /** ⛔ The dispatch's ARGS + the connection-axis predicate — the one admission term
     *  that depends on WHAT is dispatched rather than WHICH op. Both optional: absent
     *  ⇒ the fence is a no-op, matching every other grant seam here (a resume re-admits
     *  without re-reading args, and its original dispatch already passed). */
    args?: Record<string, unknown>;
    admitsConnection?: (source: ExecutionSource, connection_name: string) => boolean;
  },
): ReturnType<typeof evaluatePreflightAdmission> => {
  const { catalogSlug, manifest, operation, executionSource } = p;
  const hasContract = executionSourceHasContract(executionSource);
  // ⛔⛔ THE CONNECTION FENCE — THE SECOND DOOR. `admitOne` in `execute-handler.ts` is
  // the first and is a SEPARATE implementation, not a caller of this. Putting the term
  // in this shared core covers both remaining callers at once — raw-op dispatch (how an
  // MCP door invokes a catalog op directly, which is exactly the caller a
  // `connection_names` scope is authored to restrict) and the D-192 work-entity
  // escalation seam.
  //
  // 🔑 ONE RULE, TWO DOORS, AND THIS FILE'S OWN HEADER ALREADY NAMES THE PAIR for the
  // op gate. A term added at one door and not the other is the `file.search` failure
  // wearing different clothes: correct-looking at each site, and one of them admits.
  if (p.admitsConnection !== undefined) {
    const fenced = remoteFileConnectionNamesIn(p.args)
      .find((name) => !p.admitsConnection!(executionSource, name));
    if (fenced !== undefined) {
      return Object.freeze({
        verdict: 'deny',
        code: 'connection_not_in_scope',
        detail: `this dispatch reads a file from connection '${fenced}', which this dispatch's governing contract does not admit`,
      }) as ReturnType<typeof evaluatePreflightAdmission>;
    }
  }
  // Short op key → DECLARED operation_id (`?? operation` fallback, the canonical
  // pattern at raw-op-dispatch:595) — the op-grant-entry format for the op-admission
  // gate (`isOpGranted`, below). The op axis retired when `contract_grant` became the
  // sole op authority — home #2.
  const overlayOpId = manifest.operations?.[operation]?.operation_id ?? operation;
  const scopePath = deriveDispatchScope(
    { kind: manifest.kind, slug: catalogSlug },
    { connection_kind: RAW_OP_DISPATCH_CONNECTION_KIND },
  );
  const decision = evaluatePreflightAdmission({
    source: executionSource,
    tool: { slug: catalogSlug, kind: manifest.kind, risk_tier: manifest.risk_tier },
    ...(hasContract && p.contractSnapshot !== undefined
      ? { contract_snapshot: p.contractSnapshot }
      : {}),
    // D-187 slice 5 — the derived `data.*` / `connection.*` scope path is gated against
    // the snapshot's `scope_restrictions` (the per-door collection fence). The matrix
    // baseline `scan` + the overlay cell are retired.
    ...(scopePath !== null ? { scope_path: scopePath } : {}),
  });
  // D-187 AMENDMENT 3b — op-admission grant gate, IDENTICAL to `handleExecute`'s
  // `admitOne`: layer the unified grant store's `op` entry on top so an explicit revoke
  // on the governing contract (owner or door) denies (`op_not_granted`) even when the
  // snapshot/cell admits. Tighten-only: a `deny` stays a deny; no governing
  // contract / undefined op ⇒ the gate is a no-op.
  // D-188 — the master pause freezes every GOVERNED dispatch. Coarser than the
  // per-op grant, so checked first → a paused server denies with the honest
  // `server_paused` code, not `op_not_granted`. Contract-free sources bypass
  // (`isFrozenByPause`).
  if (
    decision.verdict !== 'deny'
    && opAdmissionGate?.isFrozenByPause(executionSource)
  ) {
    return Object.freeze({
      verdict: 'deny',
      code: 'server_paused',
      detail:
        'server is paused — contracted and AI operations are halted until the owner resumes',
    });
  }
  if (
    decision.verdict !== 'deny'
    && opAdmissionGate
    && !opAdmissionGate.isOpGranted(executionSource, overlayOpId)
  ) {
    return Object.freeze({
      verdict: 'deny',
      code: 'op_not_granted',
      detail: `operation '${overlayOpId}' is not granted to this dispatch's governing contract (revoked)`,
    });
  }
  return decision;
};

// ────────────────────────────────────────────────────────────────
// The gateway dispatch core — fresh + resume share it.
// ────────────────────────────────────────────────────────────────

/** The op identity + connection a raw-op gateway dispatch needs. */
interface RawOpGatewayCall {
  catalogSlug: string;
  manifest: IngredientManifest;
  operation: string;
  opArgs: Record<string, unknown>;
  connectionName: string;
  executionSource: ExecutionSource;
}

/** Build the recipe-less catalog session-grant hooks for a FRESH raw-op
 *  dispatch: `match` consults the door's live `raw_op` grants (recipe-less — the
 *  match arm binds on op + connection scope, never reads recipe identity) and
 *  `consume` decrements one at the proceed point, so a previously-minted grant
 *  auto-admits the next identical write. The grant binds the SAME channel
 *  session this match recomputes (`deriveChannelSessionId`). The catalog-gate
 *  INLINE mint is unreachable for a raw op (a fresh dispatch sets no
 *  `preflight_session_grant` stepMeta marker; the resume mints externally via
 *  `mintRawOp`) — a no-op satisfies the required hook. */
const buildRawOpCatalogGrants = (
  resolver: SessionGrantResolver,
  source: ExecutionSource,
): CatalogSessionGrantHooks => {
  const channel_session_id = deriveChannelSessionId(source);
  // D-177 N.14.6 — the door binding, on BOTH legs. Match: a door never rides an
  // unbound row, and a bound row demands this id. Consume: the store re-verifies
  // the same equality at the spend, so a bound grant that matched here and then
  // consumed WITHOUT the id would fail to spend and re-ask forever.
  const source_contract_id = isDoorDispatchSource(source)
    ? executionSourceContractId(source)
    : undefined;
  // The owner-vs-door discriminator (supplied for the owner's mcp client too —
  // absence classifies as a door, which would refuse the owner's own grants).
  const mcp_token_id = source.channel === 'mcp' ? source.mcp_token_id : undefined;
  return {
    match: (call: CatalogGrantCall): string | null =>
      resolver.match({
        channel: source.channel,
        actor: source.actor,
        channel_session_id,
        ...(source_contract_id !== undefined ? { source_contract_id } : {}),
        ...(mcp_token_id !== undefined ? { mcp_token_id } : {}),
        ingredient_slug: call.ingredient_slug,
        operation_id: call.operation_id,
        ...(call.connection_name !== undefined
          ? { connection_name: call.connection_name }
          : {}),
        risk_tier: call.risk_tier,
        pre_lift_approval: call.pre_lift_approval,
        arg_shape_hash: call.arg_shape_hash,
        canonical_payload_hash: call.canonical_payload_hash,
      }),
    consume: (contract_id, call) =>
      resolver.consume(contract_id, {
        ...(call ?? {}),
        ...(source_contract_id !== undefined ? { source_contract_id } : {}),
      }),
    mint: () => {
      /* raw-op grants mint via SessionGrantResolver.mintRawOp on resume, never the catalog gate */
    },
  };
};

/** Steps 6-7 — build the recipe-less `ExecutionContext` and dispatch through the
 *  SAME catalog Gateway every recipe op crosses. FRESH mode wires
 *  `catalogSessionGrants` (a minted `raw_op` grant auto-admits); RESUME mode
 *  omits it and instead marks the gated dispatch `preflight_admitted` with the
 *  approved op-identity target (the gate re-verifies the re-resolved identity —
 *  a drift re-raises). Meters one contract use on a boundary-CROSSING call.
 *  Returns the dispatch result or a `preflight` marker; re-throws a non-preflight
 *  gateway error (deny / executor failure) for the caller's catch. */
const runRawOpThroughGateway = async (
  deps: RawOpDispatchDeps,
  call: RawOpGatewayCall,
  resume?: boolean,
): Promise<
  | {
      kind: 'result';
      result: unknown;
      /** Fresh post-authorization posture from this dispatch's gateway audit. */
      pre_lift_approval?: OperationApproval;
    }
  | { kind: 'preflight'; signal: PreflightRequiredSignal }
> => {
  const { catalogSlug, manifest, operation, opArgs, connectionName, executionSource } = call;
  const contractId = executionSourceContractId(executionSource);
  // A door's raw op always arrives on `mcp`; `tool_call_id` is the per-call
  // burst correlation id (narrowed — only on the mcp `ExecutionSource` variant).
  const correlationId =
    executionSource.channel === 'mcp' ? executionSource.tool_call_id : undefined;
  const stores = createNamespaceStores({}, {}, {});
  const ingredientExecutor = (deps.buildExecutor ?? createBoundExecutor)(
    deps.executorConfig,
    stores,
  );
  // Capture the gateway audit so metering fires only on a boundary-CROSSING call.
  let captured: GatewayCallAudit | undefined;
  const durableEmit = deps.auditLog ? createGatewayAuditEmitter(deps.auditLog) : undefined;
  const catalogSessionGrants =
    !resume && deps.sessionGrantResolver !== undefined
      ? buildRawOpCatalogGrants(deps.sessionGrantResolver, executionSource)
      : undefined;
  // RESUME — the approved op-identity target the gate re-verifies. The
  // operation axis MUST equal `resolution.operation_id`, which the gate derives
  // as the op's DECLARED `operation_id` (NOT the short `operations`-map key), so
  // resolve it the same way off the manifest here (fallback to the key when the
  // op declares none, matching the gate's own fallback).
  const approvedTarget: PreflightApprovedTarget | undefined = resume
    ? {
        ingredient_slug: catalogSlug,
        operation_id: manifest.operations?.[operation]?.operation_id ?? operation,
        connection_name: connectionName,
      }
    : undefined;
  const ctx: ExecutionContext = {
    // recipe: UNDEFINED — genuinely recipe-less (§8).
    stores,
    ingredientExecutor,
    manifestGetter: (slug, requestedVersion) =>
      deps.executorConfig.manifests.get(slug, requestedVersion),
    ...(deps.connectionOperationProfiles
      ? {
          connectionProfileResolver: (name: string) =>
            deps.connectionOperationProfiles!.get(name),
        }
      : {}),
    ...(deps.connectionStore
      ? {
          connectionSubresourcePathResolver: (name: string) =>
            deps.connectionStore!.get('api', name)?.subresource_path,
          connectionBaseUrlResolver: (name: string) =>
            connectionBaseUrlFromConfig(deps.connectionStore!.get('api', name)?.config_json),
        }
      : {}),
    ...(deps.ingestFileDownload ? { ingestFileDownload: deps.ingestFileDownload } : {}),
    onGatewayCall: (event) => {
      captured = event;
      try {
        durableEmit?.(event);
      } catch {
        /* audit is best-effort — never break the dispatch */
      }
    },
    ...(deps.customerUsage
      ? {
          onCatalogDispatchProceed: () => {
            const usage = deps.customerUsage!.reserveOnce(
              DIRECT_MCP_TOOL_CALL_BASE_RESERVATION_KEY,
              {
                tool_name: 'direct-mcp-raw-op',
                usage_kind: 'tool_call',
                units: 1,
              },
            );
            if (!usage.admitted) throw new Error(usage.message);
          },
        }
      : {}),
    actor: executionSource.actor,
    execution_source: executionSource,
    ...(correlationId ? { correlation_id: correlationId } : {}),
    ...(contractId !== undefined ? { contract_id: contractId } : {}),
    ...(deps.contractScan ? { contractScan: deps.contractScan } : {}),
    ...(catalogSessionGrants ? { catalogSessionGrants } : {}),
    trigger_source: 'mcp',
  };

  const meterIfDispatched = (): void => {
    const crossedBoundary =
      captured?.outcome === 'success'
      || (captured?.outcome === 'failed' && captured.failure_mode === 'error');
    if (
      crossedBoundary
      && deps.contractOverlay !== undefined
      // The metering op axis retired (home #2 — `contract_grant` owns op admission),
      // so `shouldMeterUse` matches `admitRawOp`'s gate automatically
      // (channel×actor×ingredient, not op); no op id needed. An op-PRESENT out-of-scope
      // op never reaches here (the op gate denies before proceed); an op-ABSENT dispatch
      // by an op-scoped contract DOES meter — a fail-safe over-count, spec `:253`.
      && deps.contractOverlay.shouldMeterUse(executionSource, catalogSlug)
    ) {
      deps.contractOverlay.recordUse(executionSource);
    }
  };

  const stepMeta: RawOpStepMeta = {
    step_id: RAW_OP_STEP_ID,
    actor: executionSource.actor,
    trigger_source: 'mcp',
    ...(contractId !== undefined ? { contract_id: contractId } : {}),
    // RESUME — admit the catalog gate's ask via the approved op-identity target
    // (the gate re-verifies the re-resolved (ingredient, operation, connection);
    // a drift re-raises a fresh preflight, never honoring the stale approval).
    ...(approvedTarget !== undefined
      ? { preflight_admitted: true, preflight_approved_target: approvedTarget }
      : {}),
  };

  try {
    const result = await runCatalogOperation(
      ctx,
      manifest,
      catalogSlug,
      { operation, args: opArgs },
      connectionName,
      undefined,
      undefined,
      stepMeta,
    );
    meterIfDispatched();
    return {
      kind: 'result',
      result,
      ...(captured?.approval !== undefined
        ? { pre_lift_approval: captured.approval }
        : {}),
    };
  } catch (e) {
    if (isPreflightRequiredSignal(e)) return { kind: 'preflight', signal: e };
    meterIfDispatched();
    throw e;
  }
};

// ────────────────────────────────────────────────────────────────
// The hold — mint a recipe-less Checkpoint + raise the D-158 ask.
// ────────────────────────────────────────────────────────────────

/** The frozen held call + the rendering context for {@link buildRawOpHold}. */
interface RawOpHoldInput {
  opId: string;
  catalogSlug: string;
  operation: string;
  opArgs: Record<string, unknown>;
  connectionName: string;
  executionSource: ExecutionSource;
  contractSnapshot?: ContractSnapshot;
  correlationId?: string;
}

/** Resolve the `raw_op` session-grant offer for a hold — the `(mcp ×
 *  contracted_user)` cell's bounds, tagged `grant_mode: 'raw_op'`. Offered ONLY
 *  when the action-identity hashes are present (a `raw_op` grant binds the exact
 *  payload — `mintRawOpGrant` requires both; an `allow_session` with no hashes
 *  could mint nothing, so make no offer). */
const resolveRawOpOffer = (
  deps: RawOpDispatchDeps,
  source: ExecutionSource,
  risk_tier: string,
  argShapeHash: string | undefined,
  canonicalPayloadHash: string | undefined,
  authorizationProvenance: AuthorizationProvenance | undefined,
): SessionGrantOffer | undefined => {
  // No mint path (no resolver) ⇒ make no offer — an `allow_session` answer
  // could mint nothing, so don't surface the option (codex LOW fold).
  if (deps.sessionGrantResolver === undefined) return undefined;
  if (argShapeHash === undefined || canonicalPayloadHash === undefined) return undefined;
  const base = resolveSessionGrantOffer({
    channel: source.channel,
    actor: source.actor,
    risk_tier,
    pre_lift_approval: authorizationProvenance?.pre_lift_approval,
  });
  return base !== undefined ? { ...base, grant_mode: 'raw_op' } : undefined;
};

/** Build the durable recipe-less hold: mint a `Checkpoint` carrying the frozen
 *  held call (the `raw_op` discriminant), persist it, and raise the D-158 ask.
 *  Returns `held` on success. Degrades to the not-wired `ask` stub when the
 *  hold substrate is unwired or the checkpoint write fails (anti-loop — never
 *  silently dispatch a write). In receipt-backed composition an ask-raise
 *  failure leaves the checkpoint + receipt live: the ask may already have
 *  committed before the error, and boot recovery either relinks that exact ask
 *  or safely raises the missing one. Legacy composition without receipts keeps
 *  its historical cleanup behavior. */
const buildRawOpHold = async (
  deps: RawOpDispatchDeps,
  hold: RawOpHoldInput,
  ctx: {
    reason: string;
    risk_tier: string;
    arg_shape_hash?: string;
    canonical_payload_hash?: string;
    owner_override_offer?: PreflightRequiredSignal['owner_override_offer'];
    approval_clamped_from?: PreflightRequiredSignal['approval_clamped_from'];
    authorization_provenance?: AuthorizationProvenance;
  },
): Promise<RawOpDispatchOutcome> => {
  if (deps.checkpointStore === undefined || deps.preflightNotifier === undefined) {
    return { kind: 'ask', op_id: hold.opId, message: approvalNotWiredAsk(hold.opId, ctx.reason) };
  }
  const newId = deps.newId ?? randomUUID;
  const createdAt = (deps.now ?? Date.now)();
  const run_id = newId();
  const checkpoint: Checkpoint = {
    checkpoint_id: newId(),
    run_id,
    step_state: {},
    preflight_context: {
      tool_slug: hold.operation,
      connection_name: hold.connectionName,
      risk_tier: ctx.risk_tier,
      reason: ctx.reason,
      // Raw-op exposure fences CLI/service execution, so a returned value is
      // always the completed provider result. Persist the trusted fact rather
      // than inferring from provider-controlled JSON on resume.
      gated_action_settlement_mode: 'returned_result',
      // D-161 Part B (display) — name the STARTER, exactly as the recipe path
      // does at its own checkpoint write (`execute-handler.ts`).
      //
      // ⛔ THIS PATH IS THE ONE THAT MOST NEEDS IT, AND IT WAS MISSED. A raw op
      // is a door dispatch BY CONSTRUCTION — `RawOpCheckpoint.execution_source`
      // is documented as "the door's MCP ExecutionSource". Its ask opens "An AI
      // agent wants to run …", which says an agent asked but NOT whether it is
      // the owner's own desktop client or a third party's delegated token —
      // precisely the distinction this line exists to draw. Left unstamped it
      // stayed silent here AND on every boot re-raise, since the sweep renders
      // from this same stored context.
      ...(isDoorDispatchSource(hold.executionSource)
        ? { origin_actor: hold.executionSource.actor }
        : {}),
      ...(ctx.owner_override_offer !== undefined
        ? { owner_override_offer: ctx.owner_override_offer }
        : {}),
      ...(ctx.approval_clamped_from !== undefined
        ? { approval_clamped_from: ctx.approval_clamped_from }
        : {}),
      ...(ctx.authorization_provenance !== undefined
        ? { authorization_provenance: ctx.authorization_provenance }
        : {}),
    },
    raw_op: {
      op_id: hold.opId,
      catalog_slug: hold.catalogSlug,
      operation: hold.operation,
      connection_name: hold.connectionName,
      op_args: hold.opArgs,
      execution_source: hold.executionSource,
      ...(hold.contractSnapshot !== undefined
        ? { contract_snapshot: hold.contractSnapshot }
        : {}),
      // D-182 §8 follow-on — freeze the door's BOUND contract id (when the token
      // is contract-bound) so the resume can re-probe its liveness (kill-switch).
      // Undefined for an unbound token ⇒ no contract to kill, no re-probe.
      ...(deps.boundContractId !== undefined
        ? { bound_contract_id: deps.boundContractId }
        : {}),
      risk_tier: ctx.risk_tier,
      ...(ctx.arg_shape_hash !== undefined ? { arg_shape_hash: ctx.arg_shape_hash } : {}),
      ...(ctx.canonical_payload_hash !== undefined
        ? { canonical_payload_hash: ctx.canonical_payload_hash }
        : {}),
      ...(hold.correlationId !== undefined ? { correlation_id: hold.correlationId } : {}),
    },
    created_at: createdAt,
  };
  try {
    await deps.checkpointStore.write(checkpoint);
  } catch (e) {
    console.warn(
      `[raw-op-hold] checkpoint write failed for '${hold.opId}': `
        + (e instanceof Error ? e.message : String(e)),
    );
    return { kind: 'ask', op_id: hold.opId, message: approvalNotWiredAsk(hold.opId, ctx.reason) };
  }
  let actionRef: string | undefined;
  if (deps.gatedActionStore !== undefined) {
    try {
      const receipt = await deps.gatedActionStore.createHeld({
        run_id,
        gated_step_id: RAW_OP_STEP_ID,
        checkpoint_id: checkpoint.checkpoint_id,
        ingredient_slug: hold.catalogSlug,
        operation_id: hold.operation,
        settlement_mode: 'returned_result',
        ...(hold.connectionName !== ''
          ? { connection_name: hold.connectionName }
          : {}),
      });
      actionRef = receipt.action_ref;
    } catch (error) {
      console.warn(
        `[raw-op-hold] receipt write failed for '${hold.opId}': `
          + (error instanceof Error ? error.message : String(error)),
      );
    }
    if (actionRef === undefined) {
      // The checkpoint is the retry source. Do not expose an owner decision
      // without the receipt identity that will carry its eventual outcome;
      // boot recovery creates the receipt before re-raising the ask.
      return { kind: 'held', op_id: hold.opId, run_id };
    }
  }
  const offer = resolveRawOpOffer(
    deps,
    hold.executionSource,
    ctx.risk_tier,
    ctx.arg_shape_hash,
    ctx.canonical_payload_hash,
    ctx.authorization_provenance,
  );
  const askContext: PreflightAskContext = {
    raw_op: { op_id: hold.opId },
    tool_slug: hold.operation,
    risk_tier: ctx.risk_tier,
    reason: ctx.reason,
    ...(offer !== undefined ? { session_grant: offer } : {}),
    ...(ctx.owner_override_offer !== undefined
      ? { owner_override_offer: ctx.owner_override_offer }
      : {}),
    ...(ctx.approval_clamped_from !== undefined
      ? { approval_clamped_from: ctx.approval_clamped_from }
      : {}),
    ...(ctx.authorization_provenance !== undefined
      ? { authorization_provenance: ctx.authorization_provenance }
      : {}),
  };
  try {
    const { ask_id } = await raisePreflightAsk(
      deps.preflightNotifier,
      { checkpoint, context: askContext },
    );
    if (actionRef !== undefined) {
      try {
        await deps.gatedActionStore?.linkApproval(actionRef, actionRef, ask_id);
      } catch (error) {
        console.warn(
          `[raw-op-hold] receipt ask link failed for '${hold.opId}': `
            + (error instanceof Error ? error.message : String(error)),
        );
      }
    }
  } catch (e) {
    if (actionRef !== undefined) {
      // `NotificationBlock.ask` persists before its host hooks and delivery. A
      // rejection therefore does not prove that no ask exists. Keep the durable
      // operation identity and its checkpoint paired; boot recovery consults the
      // unresolved-ask index before it creates another render. Cancelling here
      // would orphan a potentially actionable approval and erase its result path.
      console.warn(
        `[raw-op-hold] ask raise failed for '${hold.opId}'; leaving the durable hold for recovery: `
          + (e instanceof Error ? e.message : String(e)),
      );
      return { kind: 'held', op_id: hold.opId, run_id };
    }
    // Legacy, receipt-less composition has no operation record for recovery.
    // Delete the orphan checkpoint and degrade to the stub (never dispatch).
    try {
      await deps.checkpointStore.delete(checkpoint.checkpoint_id);
    } catch {
      /* best-effort cleanup */
    }
    console.warn(
      `[raw-op-hold] ask raise failed for '${hold.opId}': `
        + (e instanceof Error ? e.message : String(e)),
    );
    return { kind: 'ask', op_id: hold.opId, message: approvalNotWiredAsk(hold.opId, ctx.reason) };
  }
  return { kind: 'held', op_id: hold.opId, run_id };
};

// ────────────────────────────────────────────────────────────────
// Resume / deny — the answer round-trip (called by the PreflightResumer).
// ────────────────────────────────────────────────────────────────

/** In-flight raw-op resume claims, keyed by `checkpoint_id` — the SAME-PROCESS
 *  concurrency guard for {@link resumeRawOp} (defense-in-depth for a write). The
 *  D-158 notification block's once-only `recordAnswer` (open→answered) is the
 *  PRIMARY serializer — it dispatches one answer once, so the answer handler
 *  calls `resumeRun` once per checkpoint (the recipe resume relies on the same
 *  guarantee). This set additionally collapses any concurrent same-process
 *  re-entry on the SAME checkpoint (claimed synchronously, before any await), so
 *  a write can never double-act even if the block's dedup ever regressed.
 *  Process-local by design — a crash restarts the process (not concurrent), and
 *  the durable get-then-delete claim below covers the already-consumed case. */
const inflightRawOpResumes = new Set<string>();

type RawOpHold = NonNullable<Checkpoint['raw_op']>;

/** Inc B-writes — resume a recipe-LESS raw-op door hold after the owner answered
 *  approve / allow_session. Re-dispatches the FROZEN op through the catalog
 *  Gateway (admitted past the ask via the op-identity target), then mints the
 *  `raw_op` grant on an `allow_session` answer (so the next identical call
 *  auto-admits).
 *
 *  AT-MOST-ONCE (two layers): a synchronous in-process claim
 *  ({@link inflightRawOpResumes}) collapses a same-process concurrent re-entry,
 *  and the checkpoint is durably CLAIMED (deleted) before the dispatch — so the
 *  notification block's at-least-once answer re-dispatch (a crash mid-resume)
 *  never double-acts a write; a lost approval simply re-asks via a fresh agent
 *  call (the safe failure mode for a side-effecting op). Never throws (the
 *  resumer's contract): a missing checkpoint / re-resolve failure / policy deny
 *  on resume / dispatch error / op-identity drift all log + return without
 *  dispatching. */
export const resumeRawOp = async (
  deps: RawOpDispatchDeps,
  checkpoint: Checkpoint,
  opts: {
    session_grant?: {
      ttl_ms: number;
      max_uses: number;
      risk_tier: string;
      grant_mode?: string;
    };
  },
): Promise<RawOpResumeOutcome> => {
  const raw = checkpoint.raw_op;
  if (raw === undefined) return { kind: 'skipped', reason: 'not_raw_op' };
  // Synchronous in-process claim — closes a same-process concurrent re-entry on
  // this exact checkpoint (no `await` between `has` + `add`). Released in the
  // `finally` so a re-run after this resume settles can still proceed.
  if (inflightRawOpResumes.has(checkpoint.checkpoint_id)) {
    console.warn(
      `[raw-op-resume] checkpoint ${checkpoint.checkpoint_id} resume already in flight — skipping (concurrent answer)`,
    );
    return { kind: 'skipped', reason: 'resume_already_in_flight' };
  }
  inflightRawOpResumes.add(checkpoint.checkpoint_id);
  try {
    return await dispatchResumedRawOp(deps, checkpoint, raw, opts);
  } finally {
    inflightRawOpResumes.delete(checkpoint.checkpoint_id);
  }
};

/** The claimed body of {@link resumeRawOp} (runs under the in-process claim). */
const dispatchResumedRawOp = async (
  deps: RawOpDispatchDeps,
  checkpoint: Checkpoint,
  raw: RawOpHold,
  opts: {
    session_grant?: {
      ttl_ms: number;
      max_uses: number;
      risk_tier: string;
      grant_mode?: string;
    };
  },
): Promise<RawOpResumeOutcome> => {
  // 1 — AT-MOST-ONCE durable claim. Read-then-delete: a gone checkpoint means a
  //     prior attempt already consumed it — skip (never re-dispatch a write).
  //     The answer handler's trailing delete then no-ops.
  if (deps.checkpointStore === undefined) {
    console.warn(
      `[raw-op-resume] no checkpoint store — cannot claim hold ${checkpoint.checkpoint_id}; skipping`,
    );
    return {
      kind: 'failed',
      code: 'checkpoint_store_unavailable',
      message: 'The held raw operation could not claim its checkpoint because checkpoint storage is unavailable.',
    };
  }
  let existing: Checkpoint | null;
  try {
    existing = await deps.checkpointStore.get(checkpoint.checkpoint_id);
  } catch (e) {
    console.warn(
      `[raw-op-resume] checkpoint get failed for ${checkpoint.checkpoint_id}: `
        + (e instanceof Error ? e.message : String(e)),
    );
    return {
      kind: 'failed',
      code: 'checkpoint_read_failed',
      message: 'The held raw operation could not read its checkpoint during resume.',
    };
  }
  if (existing === null) {
    console.warn(
      `[raw-op-resume] checkpoint ${checkpoint.checkpoint_id} already consumed — skipping (at-most-once)`,
    );
    return { kind: 'skipped', reason: 'checkpoint_already_consumed' };
  }
  try {
    await deps.checkpointStore.delete(checkpoint.checkpoint_id);
  } catch (e) {
    console.warn(
      `[raw-op-resume] checkpoint claim (delete) failed for ${checkpoint.checkpoint_id}: `
        + (e instanceof Error ? e.message : String(e)),
    );
    return {
      kind: 'failed',
      code: 'checkpoint_claim_failed',
      message: 'The held raw operation could not claim its checkpoint and was not dispatched.',
    };
  }

  // 2 — re-resolve the op (the pack may have been uninstalled while paused) +
  //     §8 KIND fence.
  const resolved = resolveRawOpBinding(deps, raw.op_id);
  if (resolved.kind !== 'ok') {
    console.warn(`[raw-op-resume] cannot resume '${raw.op_id}': ${resolved.message}`);
    return { kind: 'failed', code: 'operation_unavailable', message: resolved.message };
  }
  // Op-identity drift (codex HIGH fold) — if the op id now resolves to a
  // DIFFERENT backing catalog than the hold froze (the pack was re-pointed while
  // paused), the approval no longer names this implementation. Fail closed: the
  // dispatch below uses the FROZEN `raw.catalog_slug`, so a divergent
  // `resolved.manifest` must never be paired with it. (`resolved.operation`
  // equals `raw.operation` by construction — both parse from `raw.op_id`.)
  if (resolved.binding.catalog_slug !== raw.catalog_slug) {
    console.warn(
      `[raw-op-resume] '${raw.op_id}' now resolves to catalog '${resolved.binding.catalog_slug}', `
        + `not the approved '${raw.catalog_slug}' (pack re-pointed while paused) — not dispatching`,
    );
    return {
      kind: 'failed',
      code: 'operation_binding_drift',
      message: 'The operation binding changed while approval was pending; the stale approval was not used.',
    };
  }

  // 3 — D-196 R2 fresh authority. The checkpoint's source/snapshot prove what
  //     the owner approved, but never authorize the later effect. Re-read the
  //     bearer and rebuild the snapshot now. The exact raw wire grant is
  //     load-bearing: `admitRawOp` aliases the backing catalog slug after Gate A,
  //     so without this re-check a revoked `recued_op_<op-id>` could be silently
  //     re-admitted from the stale approval. A missing resolver is itself a
  //     denial: the frozen liveness/Seller checks below remain defense in depth,
  //     but they cannot reconstruct current bearer grants or the read fence.
  let resumeExecutionSource = raw.execution_source;
  let resumeContractSnapshot = raw.contract_snapshot;
  if (!deps.approvalResumeAuthority) {
    console.warn(
      `[raw-op-resume] '${raw.op_id}' approval-resume authority resolver is unavailable — not dispatching`,
    );
    return {
      kind: 'failed',
      code: 'resume_authority_unavailable',
      message: 'Fresh MCP authority could not be resolved, so the approved operation was not dispatched.',
    };
  }
  let authority: ReturnType<
    NonNullable<RawOpDispatchDeps['approvalResumeAuthority']>['resolve']
  >;
  try {
    authority = deps.approvalResumeAuthority.resolve({
      execution_source: raw.execution_source,
      required_bearer_tool_names: [`recued_op_${raw.op_id}`],
      required_raw_op_id: raw.op_id,
    });
  } catch (error) {
    console.warn(
      `[raw-op-resume] '${raw.op_id}' fresh authority resolution failed: `
        + (error instanceof Error ? error.message : String(error))
        + ' — not dispatching',
    );
    return {
      kind: 'failed',
      code: 'resume_authority_error',
      message: 'Fresh MCP authority resolution failed, so the approved operation was not dispatched.',
    };
  }
  if (!authority.admitted) {
    console.warn(
      `[raw-op-resume] '${raw.op_id}' fresh authority denied `
        + `(${authority.reason}: ${authority.detail}) — not dispatching`,
    );
    return {
      kind: 'failed',
      code: authority.reason,
      message: `Fresh MCP authority denied the approved operation: ${authority.detail}`,
    };
  }
  if (authority.contract_snapshot === undefined) {
    console.warn(
      `[raw-op-resume] '${raw.op_id}' fresh authority returned no contract snapshot — not dispatching`,
    );
    return {
      kind: 'failed',
      code: 'resume_contract_snapshot_missing',
      message: 'Fresh MCP authority returned no contract snapshot; the approved operation was not dispatched.',
    };
  }
  resumeExecutionSource = authority.execution_source;
  resumeContractSnapshot = authority.contract_snapshot;

  // 4 — bound-contract KILL-SWITCH re-check (defense in depth). When
  //     the door's inbound token was contract-bound, re-probe THAT contract's
  //     liveness NOW via the SAME `contractOverlay.isContractLive` the MCP
  //     transport applies at request entry: a contract revoked / expired /
  //     exhausted WHILE this write was paused must block the resume even though
  //     the owner approved — revoke is a LIVE kill-switch over EVERY dispatch
  //     path, and a held WRITE is the riskiest to let slip through. Fail-closed:
  //     a bound id we cannot verify (no overlay resolver) is treated as dead
  //     (mirrors the transport's `isContractLive(...) ?? false`). An UNBOUND
  //     token (`bound_contract_id` absent) has no contract to kill — skip the
  //     probe (its `execution_source.contract_id` is the token id, not a
  //     contract, so probing it would wrongly fail-close a legitimate resume).
  if (
    raw.bound_contract_id !== undefined
    && deps.contractOverlay?.isContractLive(raw.bound_contract_id) !== true
  ) {
    console.warn(
      `[raw-op-resume] '${raw.op_id}' bound contract '${raw.bound_contract_id}' is no longer live `
        + '(revoked / expired / exhausted while paused) — not dispatching (kill-switch)',
    );
    return {
      kind: 'failed',
      code: 'bound_contract_inactive',
      message: 'The MCP contract was revoked, expired, or exhausted while approval was pending.',
    };
  }
  // D-196 R1a — the direct-MCP transport applies this pairing on the fresh
  // request, but a held raw op outlives that request. Reclassify the frozen
  // bound id from the same authoritative contract resolver and re-run exact
  // Seller pairing here. A known customer instance denies even when Seller
  // storage disappeared; legacy stubs with no classifier keep their prior
  // row-discovery behavior.
  if (
    raw.bound_contract_id !== undefined
    && resumeExecutionSource.channel === 'mcp'
  ) {
    try {
      const contractKind = deps.contractOverlay?.resolveBoundContractKind
        ? deps.contractOverlay.resolveBoundContractKind(raw.bound_contract_id) ?? null
        : undefined;
      const sellerAdmission = evaluateSellerCustomerAccessAdmission({
        ...(deps.sellerCustomerAdmissionStore
          ? { sellerStore: deps.sellerCustomerAdmissionStore }
          : {}),
        token: {
          token_id: resumeExecutionSource.mcp_token_id,
          contract_id: raw.bound_contract_id,
        },
        now: (deps.now ?? Date.now)(),
        contractKind,
      });
      if (sellerAdmission.applies === true && sellerAdmission.admitted !== true) {
        console.warn(
          `[raw-op-resume] '${raw.op_id}' seller customer admission denied on resume `
            + `(${sellerAdmission.reason}) — not dispatching`,
        );
        return {
          kind: 'failed',
          code: `seller_${sellerAdmission.reason}`,
          message: 'Seller-customer admission no longer permits this approved operation.',
        };
      }
    } catch (e) {
      console.warn(
        `[raw-op-resume] '${raw.op_id}' seller customer admission check failed on resume: `
          + (e instanceof Error ? e.message : String(e))
          + ' — not dispatching',
      );
      return {
        kind: 'failed',
        code: 'seller_admission_error',
        message: 'Seller-customer admission could not be verified during resume.',
      };
    }
  }

  // 5 — re-run the contract admission WITH the approval in hand: an `ask` verdict
  //     is now SATISFIED (the human approved this exact call); a `deny` means the
  //     policy/grant hard-denies since the hold — fail closed, do NOT dispatch.
  //     With R2 wiring this consumes the newly-derived snapshot (including the
  //     current collection fence). The op-admission gate below separately reads
  //     live op grants.
  const admission = admitRawOp(deps, {
    binding: resolved.binding,
    manifest: resolved.manifest,
    operation: resolved.operation,
    executionSource: resumeExecutionSource,
    ...(resumeContractSnapshot !== undefined
      ? { contractSnapshot: resumeContractSnapshot }
      : {}),
  });
  if (admission.verdict === 'deny') {
    console.warn(
      `[raw-op-resume] '${raw.op_id}' denied by contract policy on resume (${admission.detail}) — not dispatching`,
    );
    return {
      kind: 'failed',
      code: 'contract_policy_denied',
      message: `Contract policy denied the approved operation during resume: ${admission.detail}`,
    };
  }

  // 6 — dispatch through the Gateway in RESUME mode (preflight_admitted + the
  //     approved op-identity target). A non-preflight error (deny / executor
  //     failure) → the write was attempted but failed: at-most-once already
  //     held, so log + done. A re-raised preflight = op-identity drift → fail
  //     closed (never silently run a changed call past the old approval).
  let dispatch: Awaited<ReturnType<typeof runRawOpThroughGateway>> | undefined;
  try {
    dispatch = await runRawOpThroughGateway(
      deps,
      {
        catalogSlug: raw.catalog_slug,
        manifest: resolved.manifest,
        operation: raw.operation,
        opArgs: raw.op_args,
        connectionName: raw.connection_name,
        executionSource: resumeExecutionSource,
      },
      true, // RESUME mode — admit past the ask via the op-identity target
    );
  } catch (e) {
    console.warn(
      `[raw-op-resume] dispatch of '${raw.op_id}' failed: `
        + (e instanceof Error ? e.message : String(e)),
    );
    return {
      kind: 'in_doubt',
      code: 'raw_op_dispatch_in_doubt',
      message: 'The provider dispatch failed after the durable checkpoint was claimed; inspect Recued Logs before retrying because the side effect may have occurred.',
    };
  }
  if (dispatch.kind === 'preflight') {
    console.warn(
      `[raw-op-resume] '${raw.op_id}' re-raised preflight on resume (op-identity drift) — not dispatching the stale approval`,
    );
    return {
      kind: 'failed',
      code: 'operation_identity_drift',
      message: 'The operation identity changed while approval was pending; the stale approval was not used.',
    };
  }

  // 7 — `allow_session` mint: a successful approved dispatch with a session
  //     offer + the action-identity hashes mints the `raw_op` grant (bound to
  //     the SAME channel session the fresh-dispatch match recomputes). Best-
  //     effort — `mintRawOp` never throws.
  if (
    opts.session_grant !== undefined
    && raw.arg_shape_hash !== undefined
    && raw.canonical_payload_hash !== undefined
    && deps.sessionGrantResolver !== undefined
    && checkpoint.preflight_context?.authorization_provenance !== undefined
    && (
      checkpoint.preflight_context.authorization_provenance.pre_lift_approval === 'never'
      || checkpoint.preflight_context.authorization_provenance.pre_lift_approval === 'ask'
    )
    && (
      dispatch.pre_lift_approval === 'never'
      || dispatch.pre_lift_approval === 'ask'
    )
  ) {
    // Bind the grant's operation axis to the RESOLVED operation id (the op's
    // declared `operation_id`, NOT the short `operations`-map key) — the value
    // the catalog gate's grant-match recomputes as `resolution.operation_id`,
    // so the next identical fresh dispatch matches this grant.
    const resolvedOpId =
      resolved.manifest.operations?.[raw.operation]?.operation_id ?? raw.operation;
    deps.sessionGrantResolver.mintRawOp({
      channel: resumeExecutionSource.channel,
      actor: resumeExecutionSource.actor,
      channel_session_id: deriveChannelSessionId(resumeExecutionSource),
      ingredient_slug: raw.catalog_slug,
      operation_id: resolvedOpId,
      ...(raw.connection_name !== '' ? { connection_name: raw.connection_name } : {}),
      risk_tier: raw.risk_tier as RiskTier,
      pre_lift_approval: dispatch.pre_lift_approval,
      arg_shape_hash: raw.arg_shape_hash,
      canonical_payload_hash: raw.canonical_payload_hash,
      // D-177 N.14.6 — bind the grant to the door contract that governed the call
      // the owner approved. Read off the RESUME source (not `raw.bound_contract_id`,
      // which the hold froze for the liveness kill-switch): the two agree, and the
      // source is what the matcher will recompute against on the next dispatch, so
      // deriving both from it keeps mint and match reading the same field.
      // Undefined for the owner's own stdio client — not a door, stays unbound.
      ...(isDoorDispatchSource(resumeExecutionSource)
        && executionSourceContractId(resumeExecutionSource) !== undefined
        ? { source_contract_id: executionSourceContractId(resumeExecutionSource) }
        : {}),
      approved_action_ref: checkpoint.run_id,
      ttl_ms: opts.session_grant.ttl_ms,
      max_uses: opts.session_grant.max_uses,
    });
  }
  return { kind: 'completed', result: dispatch.result };
};

/** Inc B-writes — the owner DENIED a recipe-less raw-op door hold. A raw op has
 *  no run anchor to transition (unlike the recipe deny path's
 *  `RECIPE_POLICY_DENIED` audit row); the op never dispatched, so the absence of
 *  a success `GatewayCallAudit` IS the record. The answer handler consumes the
 *  checkpoint (its trailing `delete`); this is a logged no-op. Never throws. */
export const denyRawOp = async (checkpoint: Checkpoint): Promise<void> => {
  const raw = checkpoint.raw_op;
  if (raw === undefined) return;
  console.info(
    `[raw-op-deny] owner denied raw op '${raw.op_id}' (run ${checkpoint.run_id}) — not dispatched`,
  );
};
