/** D-192 P4b — the declaration-driven work-entity write executor.
 *
 *  Replaces the PA3 `VendorWriteHook` seam (Codex H5: op + payload →
 *  `source_record_id` was too thin to carry read-before-write, version
 *  compare, post-write verify, or a pending-write state). Shaped like
 *  the P3b sync runner: declaration-driven module, the SAME gated +
 *  audited `runGatedCatalogOperation` invoke spine, a scripted test
 *  seam, and the housekeeping-grade error taxonomy (`config` failures
 *  are stable-until-enrollment, never thrown).
 *
 *  Two-phase API — the dispatcher ordering depends on it:
 *
 *  1. **`prepare`** — pure config resolution (declaration → ops →
 *     bindings → manifest → pushable-field intersection). Runs BEFORE
 *     the dispatcher's local write so a structurally-unwritable Source
 *     refuses up-front (the old `SOURCE_NOT_WRITE_CAPABLE` posture) —
 *     a config refusal must never leave a silent local edit that can
 *     NEVER push. A patch with no declared-writable field returns
 *     `vendor_relevant: false`: the local write proceeds alone, no
 *     pending state (the divergence is the documented mirrored-row
 *     posture — local-only fields live locally until a vendor change
 *     rewrites the row).
 *
 *  2. **`dispatch`** — the vendor round-trip (spec § Write policy
 *     steps 1–7):
 *       update/complete: stage `pending_write` (bases from the
 *       pre-edit row) → targeted preflight read (`ops.read` +
 *       `op_bindings.read.id_arg`) → compare vendor-current version
 *       token / record hash against the staged base → unchanged or
 *       changed-disjoint: narrow patch through the declared
 *       `update`/`complete` op (payload = the projection lanes'
 *       INVERSE paths, composed as nested `body.<top>` wire args);
 *       changed-overlapping: the declared `field_conflicts` policy
 *       (`manual_merge` → a typed conflict outcome, pending stays);
 *       un-comparable (vendor row unprojectable): the declared
 *       `stale_write` policy → post-write verify (consume the write
 *       response, else re-read) → project → mirror upsert (vendor
 *       canonical result + preserved local-only fields) →
 *       `clearPendingWrite`.
 *       create: compose payload → declared `create` op → extract the
 *       vendor-native id (+ a best-effort projected version stamp)
 *       from the response — the DISPATCHER writes the local row (the
 *       user's full intent, including local-only fields the projection
 *       doesn't carry), so this path never mirror-upserts.
 *       delete: vendor-first (`ops.delete` + binding), then the
 *       dispatcher tombstones locally — a local-first delete would be
 *       resurrected by the next sync cycle while the vendor record
 *       lives.
 *
 *  Conditional writes (spec: "If the vendor supports conditional
 *  writes, the declaration must use them"): `write_policy.
 *  conditional_write` ≠ `'none'` + the write binding's
 *  `precondition_arg` → the vendor-CURRENT version token (from the
 *  preflight read — the compare already accepted that state, and the
 *  current token closes the preflight→write race; falls back to the
 *  staged base token, and is skipped when neither exists, e.g. a
 *  header-borne etag the list fetch never exposed).
 *
 *  Failure posture: any dispatch failure after staging leaves the
 *  pending write staged (`state: 'pending'`, `attempts` incremented on
 *  re-dispatch) — the local edit is real, the vendor push failed, and
 *  the row honestly carries the dirty marker. There is no background
 *  retry substrate in v1; retry = the caller re-runs the write. A
 *  successful write whose verification could not complete stages
 *  `state: 'awaiting_verify'` — the next sync cycle folds the vendor
 *  truth and clears it (the sync runner's dirty-row guard treats
 *  `awaiting_verify` as fold-and-clear, `pending` as hands-off).
 *
 *  Policy verdicts ride the same posture as the sync fetch: a gateway
 *  `ask`/`deny` surfaces as a `policy` outcome — this substrate path
 *  has no approval queue; the owner grants the operation or the write
 *  refuses. Every invoke is a first-class `connection_gateway` audit
 *  row (step ids `write_preflight` / `source_write` / `write_verify`).
 *
 *  Spec: D-192 § Write policy + § Conflict model. */

import { createHash } from 'node:crypto';
import type {
  ExecutionSource,
  IngredientManifest,
  Note,
  Project,
  RecipeDefinition,
  Task,
  WorkEntityConflictResolution,
  WorkEntityKind,
  WorkEntitySourceDeclarableKind,
  WorkEntitySourceOpBinding,
  WorkEntityTargetedOpSlot,
  WorkEntityWriteTransform,
} from '@recued/contracts';
import { isWorkEntitySourceDeclarableKind } from '@recued/contracts';

import {
  getByDotPath,
  runGatedCatalogOperation,
  type RunGatedCatalogOperationFn,
  type SourceMirrorFetchDeps,
} from './source-mirror/fetch.js';
import {
  projectWorkEntitySourceRow,
  workEntitySourceVersionToken,
  type ProjectedWorkEntityUpsert,
} from './work-entity-source-projector.js';
import type { KernelWorkEntitySourceDeclaration } from './work-entity-source-boot.js';
import type { OpAdmissionGate } from './op-admission-gate.js';
import { resolveConfigArgBindings } from './work-entity-config-args.js';
import { composeWireArgs } from './work-entity-wire-body.js';
import {
  executePlannedCreate,
  resolvePersistDependencyCreateArgs,
  resolvePersistDependencyReadArgs,
  resolvePersistDependencyWriteArgs,
  resolvePromptDependencies,
  type DependencyInvokeIdentity,
  type PlannedDependencyCreate,
  type ResolvePromptDependenciesOutcome,
} from './source-dependency-resolver.js';
import type { SourceDependencyEntityStore } from './storage/source-dependency-entity-store.js';
import type { WorkEntitySourceMirrorStore } from './storage/work-entity-source-mirror.js';
import type {
  NoteWriteInput,
  ProjectWriteInput,
  TaskWriteInput,
  WorkEntityStore,
} from './storage/work-entity-store.js';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/** Synthetic recipe identity for the scoped gateway ctx — audit rows
 *  attribute write-path invokes to `work-entity-source-write`. Never
 *  installed, never executed as a recipe. */
const SOURCE_WRITE_RECIPE: RecipeDefinition = {
  recipe_id: 'work-entity-source-write',
  version: 1,
  ttl: 0,
  metadata: {
    name: 'Work-entity Source write',
    description:
      'Synthetic identity for declared work-entity Source write-path invokes '
      + '(D-192 P4b: preflight read / vendor write / post-write verify). Not an installable recipe.',
    author: 'recued',
    supported_platforms: [],
  },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { render: [] },
};

export type WorkEntityVendorWriteOperation = 'create' | 'update' | 'delete' | 'complete';

/** D-192 baseline-admission (S2) — the actor-aware contract-grant admission for a vendor
 *  CREATE. The catalog pack declares the vendor write op `approval: 'ask'`; on the standalone
 *  write spine that `ask` has no pause path, so it degrades to a policy fail (the
 *  baseline-admission gap) — EVEN when the governing contract fully authorizes the write. The
 *  design insight: a governing contract that GRANTS the vendor write op IS the standing
 *  approval, so the grant should SATISFY the `ask`. This computes that admission; the caller
 *  ORs it onto `preflight_admitted` (the SAME server-derived channel the 6c.2c create-plan
 *  confirm uses — unforgeable, `ask`→admit only, never a `'deny'` bypass).
 *
 *  Admits ONLY the two actors that carry a STANDING authorization:
 *    - `user_self` — the OWNER, acting through their own UI (contract-free HID) or AI (the
 *      owner contract, permissive-but-tightenable). `isOpGranted` returns true unless the
 *      owner explicitly REVOKED the op (owner-tightening honored).
 *    - `contracted_user` — a DOOR; true IFF the door's bound contract GRANTS the vendor op.
 *  A `system` background fire (reactive / schedule / housekeeping) and an `anonymous`
 *  dispatch (a reception visitor, or a D-209 W3 webhook fire — its door governs the
 *  GATEWAY ceiling, never this vendor-write spine) have NO standing authorization here
 *  → NEVER admitted (the
 *  allowlist is deliberately stricter than a bare `actor !== 'system'`: it fails CLOSED for
 *  `anonymous` + any future actor, so a background write still degrades and surfaces for
 *  approval). `opId` MUST be the RESOLVED declared `operation_id` — the op-admission gate keys
 *  on it, and the fetch spine's `preflight_approved_target` re-derives the same value (the
 *  6c.2c operation_id lesson). An absent gate (unit / pre-wiring) ⇒ false (degrade-preserving).
 *
 *  S4 — EXPORTED + reused by the chat container-pick surface (`execute-handler`): the SAME
 *  predicate decides whether the tool result tells the agent it may create a NEW container,
 *  so the copy can never promise a create the fast-track would then refuse. */
export const admitVendorWrite = (
  gate: Pick<OpAdmissionGate, 'isOpGranted'> | undefined,
  source: ExecutionSource,
  opId: string,
): boolean =>
  gate !== undefined
  && (source.actor === 'user_self' || source.actor === 'contracted_user')
  && gate.isOpGranted(source, opId);

/** D-192 S4 — the actor-aware "may this contract create a NEW container to resolve
 *  an ambiguous container-pick, in ONE step?" predicate the chat catch site uses over
 *  a `container_pick_required` carrier. Requires BOTH the container create op AND the
 *  TARGET write op granted — the fast-track admits the whole plan (target write + each
 *  container create), so an accurate "you may create a new one" must check both or it
 *  over-promises a create that then falls to `not_granted`. Reuses {@link admitVendorWrite}
 *  per op (the allowlist stays single-source). Absent source / either op id / gate ⇒ false
 *  (pick-only, fail-closed). Exported so the catch site AND its tests exercise the SAME
 *  predicate, never a drifting replica. */
export const canCreateNewContainerForActor = (
  gate: Pick<OpAdmissionGate, 'isOpGranted'> | undefined,
  source: ExecutionSource | undefined,
  detail: { create_op?: string; target_write_op?: string },
): boolean =>
  source !== undefined
  && detail.create_op !== undefined
  && detail.target_write_op !== undefined
  && admitVendorWrite(gate, source, detail.create_op)
  && admitVendorWrite(gate, source, detail.target_write_op);

/** The kinds the mirror substrate carries.
 *
 *  ⚠ ALIASED to the contracts-side declarable list, not re-spelled.
 *  This was a third copy of `['task','project','note']` (the others
 *  being `WORK_ENTITY_SOURCE_DECLARABLE_KINDS` and the mirror store's
 *  `MIRROR_KINDS`), and the `prepare` guard below excluded exactly one
 *  kind by name — so every kind added afterwards fell through into the
 *  vendor write path by default. `booking` (D-210) is Recued-local and
 *  must never sync to a vendor; refusing by NON-MEMBERSHIP makes that
 *  the default for the next kind too. */
type MirrorKind = WorkEntitySourceDeclarableKind;

export interface WorkEntityWriteExecutorDeps {
  fetchDeps: SourceMirrorFetchDeps;
  mirror: WorkEntitySourceMirrorStore;
  store: Pick<WorkEntityStore, 'stagePendingWrite' | 'clearPendingWrite'>;
  /** Resolve the declaration driving one connection-Source id — the
   *  SAME declaration set registration + sync enumerate
   *  (`desiredWorkEntitySourcesFor`), so write, sync, and registration
   *  can never drift. Null when the Source has no declaration (write
   *  path config-refuses). */
  resolveDeclaration: (source_id: string) => {
    declaration: KernelWorkEntitySourceDeclaration;
    connection_name: string;
    /** D-192 — the bound connection's parsed config (non-secret), the source for
     *  `create_arg_bindings` (a per-connection STATIC create arg). The entity case
     *  — Linear `team`, Asana `workspace` — moved to `source_dependencies` (a
     *  live-picked container) in D-192 Slice 7; no shipped pack uses
     *  `create_arg_bindings` today, but the executor still resolves it. Absent =
     *  no config resolved; a create with a config-sourced arg binding config-refuses. */
    connection_config?: Record<string, unknown>;
  } | null;
  now?: () => number;
  /** D-192 source dependencies — the container-entity selection store. When
   *  wired: `resolve: 'persist'` deps that bind the READ/CREATE op merge their
   *  selected id into the args (`getSelected`; the sync cycle established it), and
   *  `resolveCreateDependencies` resolves `resolve: 'prompt'` deps at create time
   *  (fetches the choice list via `replaceEntities`, picks or asks). The FULL
   *  store — the create-assist preflight needs the list-refresh + select paths, not
   *  just `getSelected`. */
  dependencyStore?: SourceDependencyEntityStore;
  /** D-192 baseline-admission (S2) — the actor-aware op-admission gate, injected as a
   *  per-use THUNK (recompute-on-read; the gate is late-bound off `getExecuteDeps` at the
   *  composition root, so a boot-captured reference would be stale — [[feedback_per_use_credential_resolver]]).
   *  When wired: a vendor CREATE whose enclosing run carries a `user_self` (owner) or
   *  `contracted_user` (door) execution source that the governing contract GRANTS the vendor
   *  write op is admitted PAST the op's `'ask'` gate — the contract grant IS the standing
   *  approval (D-192 baseline-admission gap; see `admitVendorWrite`). Absent (unit harness /
   *  pre-wiring) ⇒ no S2 admission: the standalone spine degrades on `ask` exactly as before. */
  getOpAdmissionGate?: () => Pick<OpAdmissionGate, 'isOpGranted'> | undefined;
  /** Test seam — script the gated invoke while the shape of every
   *  request (op key, args, audit identity) stays real. Production
   *  omits it. */
  runOperation?: RunGatedCatalogOperationFn;
  /** D-214 trusted producer. The request-local correlation comes from the
   * internal registry dispatch context, never from ingredient arguments. */
  recordDeterministicVerification?(input: {
    session_id: string;
    turn_id: string;
    kind: 'passed' | 'failed';
    postcondition_key: string;
    source_event_id: string;
  }): Promise<unknown>;
  getDeterministicVerificationContext?: () => {
    session_id: string;
    turn_id: string;
  } | undefined;
}

/** One resolved catalog op the executor will invoke. */
export interface ResolvedOp {
  opKey: string;
  /** The op's declared result envelope path. Deliberately NO fallback
   *  to the manifest-level `surfaces.api.result_path` (that is the
   *  LIST envelope) — a single-record response with no op-level
   *  `result_path` sits at the response root. */
  resultPath: string | undefined;
  binding?: WorkEntitySourceOpBinding;
  /** D-192 — the op's wire transport, from `surfaces.api.executes[opKey].kind`
   *  (graphql else rest). Drives write-arg composition: a graphql op sends the
   *  narrow patch as flat graphql `variables`, a REST op as nested `body.<top>`
   *  request-body args. */
  transport: 'rest' | 'graphql' | 'mcp';
  /** D-192 — per-connection scoping args resolved from `op_arg_bindings[slot]`
   *  against the connection config at prepare time (Google Tasks `tasklist` on a
   *  targeted read; a federated project scope on a targeted write). Merged FLAT
   *  into the op args at dispatch, alongside the
   *  id_arg. Absent when the slot declares no `op_arg_bindings` (the common
   *  single-id case). Resolved at prepare because that is where the connection
   *  config is in hand (`resolveDeclaration`). */
  configArgs?: Record<string, unknown>;
}

/** The prepare-phase output the dispatcher threads back into
 *  `dispatch`. Fields are internal wiring — callers treat it as an
 *  opaque handle. */
export interface WorkEntityVendorWritePrepared {
  source_id: string;
  connection_name: string;
  kind: MirrorKind;
  operation: WorkEntityVendorWriteOperation;
  declaration: KernelWorkEntitySourceDeclaration;
  manifest: IngredientManifest;
  catalogSlug: string;
  /** Patch entries that map to a declared writable projection lane —
   *  the narrow-write field set AND the pending write's dirty set.
   *  `value` is CANONICAL; `wire_value` is what the vendor body
   *  carries — the declared `write_transforms` inverse when one
   *  exists, else the canonical value verbatim. The conflict compare
   *  runs at the WIRE's fidelity for transformed fields (both sides
   *  pushed through the inverse — see `compareVendorState`) and
   *  canonically otherwise. */
  pushable: ReadonlyArray<{
    field: string;
    remote_path: string;
    value: unknown;
    wire_value: unknown;
  }>;
  /** Resolved per-phase ops. `read` present for update/complete
   *  (mandatory read-before-write); `write` present for
   *  create/update/complete/delete. */
  readOp?: ResolvedOp;
  writeOp: ResolvedOp;
  /** D-192 — create-only vendor op args resolved from `create_arg_bindings`
   *  (e.g. Linear `teamId`), merged FLAT into the create call alongside the
   *  pushable body/variables. Empty/absent for non-create or a create with no
   *  bindings. */
  createOpArgs?: Record<string, unknown>;
  /** D-192 6c.2c — admit the vendor CREATE past its `'ask'` gate (a create-plan /
   *  container-pick re-run whose write the user already approved via the confirm).
   *  `dispatchCreate` threads it as `preflight_admitted` onto the gated invoke; the
   *  standalone spine self-builds the `(catalog, op, connection)` approved-target,
   *  so `ask`→admit only, never a `'deny'` bypass. Create-only. */
  preflight_admitted?: boolean;
}

export type WorkEntityVendorWritePrepareResult =
  | { ok: true; vendor_relevant: true; prepared: WorkEntityVendorWritePrepared }
  /** The patch touches no declared-writable vendor field — the
   *  dispatcher writes locally only, no vendor round-trip, no pending
   *  state. */
  | { ok: true; vendor_relevant: false; reason: string }
  | { ok: false; kind: 'config'; reason: string };

/** The just-written local row + identity the dispatch verifies
 *  against. `prior` is the PRE-edit snapshot (the read-before-write
 *  base); `current` is the row AFTER the dispatcher's local write
 *  (the preserve-compose source for local-only fields). */
export interface WorkEntityVendorWriteTarget {
  local_id: string;
  prior: Task | Project | Note;
  current: Task | Project | Note;
}

export interface WorkEntityVendorWriteStamp {
  source_version_token?: string;
  source_updated_at?: number;
  source_record_hash?: string;
  source_extension_blob?: Record<string, unknown>;
}

export type WorkEntityVendorWriteDispatchOutcome =
  | {
      ok: true;
      operation: 'create';
      source_record_id: string;
      /** Best-effort vendor-truth stamp projected from the create
       *  response — absent when the response record did not project
       *  (the first sync cycle then treats the row as changed via the
       *  hash-less `''` sentinel and rewrites it). */
      stamp?: WorkEntityVendorWriteStamp;
    }
  | {
      ok: true;
      operation: 'update' | 'complete';
      /** `pushed` — the narrow patch landed. `vendor_won` — the
       *  declared `source_wins` policy adopted the vendor state
       *  instead of writing. */
      applied: 'pushed' | 'vendor_won';
      /** True when the vendor canonical result landed in the mirror
       *  and the pending write cleared; false when verification is
       *  outstanding (`awaiting_verify` staged — the next sync cycle
       *  completes it). */
      verified: boolean;
    }
  | { ok: true; operation: 'delete' }
  | {
      ok: false;
      kind: 'config' | 'policy' | 'error';
      reason: string;
      /** True when a pending write was staged and remains (the local
       *  edit persists as honest dirty state). */
      staged: boolean;
    }
  | {
      /** D-192 — the post-write ASSERT failed: the vendor does NOT hold what we
       *  pushed. Distinct from `conflict` (a concurrent vendor edit we detected
       *  BEFORE writing) — this is our own write provably not landing, which
       *  almost always means a mis-declared `write_paths` / `op_bindings.id_arg`
       *  wrote into the wrong vendor field (or nothing at all). Fails LOUD: the
       *  old code folded the vendor's stale value back over the user's edit and
       *  reported `verified: true`. */
      ok: false;
      kind: 'verify_failed';
      reason: string;
      /** Canonical fields the patch pushed that the vendor did not end up
       *  holding. Empty for a delete (the whole record survived). */
      unlanded_fields: string[];
      staged: boolean;
    }
  | {
      ok: false;
      kind: 'conflict';
      reason: string;
      /** The dirty fields the vendor also changed (to different
       *  values) since the staged base. */
      conflicting_fields: string[];
      staged: true;
    };

export interface WorkEntitySourceWriteExecutor {
  prepare(input: {
    source_id: string;
    kind: WorkEntityKind;
    operation: WorkEntityVendorWriteOperation;
    patch: Record<string, unknown>;
    /** D-192 — prompt-resolved container-entity create args (a chat-named
     *  project's id → `body.data.projects`), computed by the create-assist
     *  preflight (`resolvePromptDependencies`). Merged into the create call's
     *  op args alongside the persist-selection + `create_arg_bindings` args.
     *  Create-only; a collision across the three arg sources config-fails. */
    dependencyCreateArgs?: Record<string, unknown>;
    /** D-192 6c.2c — admit the vendor CREATE past its `'ask'` gate: the write was
     *  pre-approved by a create-plan / container-pick confirm (the re-run replays
     *  under an engine-set, adapter-owned flag). Stamped onto the prepared route as
     *  `preflight_admitted`, which `dispatchCreate` threads to the gated invoke.
     *  Create-only + `ask`→admit only (never a `'deny'` bypass). */
    preadmitted?: boolean;
    /** D-192 baseline-admission (S2) — the enclosing run's execution source. Threaded so a
     *  vendor CREATE can compute the actor-aware contract-grant admission (`admitVendorWrite`):
     *  the OWNER (`user_self`) or a DOOR (`contracted_user`) whose governing contract GRANTS
     *  the vendor write op is admitted past the op's `'ask'` gate. Engine/wire-set + unforgeable
     *  — the kernel adapter's `withCreateOrigin` strips any recipe-supplied origin; the wire rpc
     *  strips + re-derives it from the authenticated caller. Absent (background / dbless) → no S2
     *  admission. NOT used for update/complete/delete (create-only admission). */
    execution_source?: ExecutionSource;
  }): WorkEntityVendorWritePrepareResult;
  dispatch(
    prepared: WorkEntityVendorWritePrepared,
    target?: WorkEntityVendorWriteTarget,
  ): Promise<WorkEntityVendorWriteDispatchOutcome>;
  /** D-192 create-assist preflight (Slice 6a/6c) — resolve the source's
   *  `resolve: 'prompt'` container dependencies for a CREATE and collect the args
   *  they bind, to thread into `prepare({ …, dependencyCreateArgs })`. Auto-resolves
   *  a singleton / stored default / caller-named match; an ambiguous container
   *  returns `{ ok: false, kind: 'ask' }` (the caller surfaces a choice — D-158).
   *  DECIDE-only (Slice 6c): a named container that doesn't exist AND whose
   *  `create_op` is GRANTED on the connection is returned as a `plannedCreates`
   *  entry (a decided-but-unexecuted create) — the caller confirms one create-plan
   *  ask then calls `executeCreatePlan`. An ungranted create degrades to pick-only.
   *  Returns empty when no dependency store is wired, the source is
   *  read_only/unresolvable (the write itself surfaces that), or no prompt
   *  dependency binds create. */
  resolveCreateDependencies(input: {
    source_id: string;
    kind: WorkEntityKind;
    /** Per-dependency-ref caller-named container ("Engineering team"). */
    named?: Record<string, string>;
    /** Caller identity for auditing the (read-tier) choice-list fetch. */
    identity?: DependencyInvokeIdentity;
  }): Promise<ResolvePromptDependenciesOutcome>;
  /** D-192 Slice 6c — EXECUTE one confirmed container create (the side-effecting
   *  half of decide-then-execute). Runs the gated `create_op` WRITE, then persists
   *  the created container as the Source's stored selection so the create's re-run
   *  auto-resolves it as a pick. Called ONCE per plan on approval; the caller's
   *  deterministic re-run id + at-entry audit guard keep an at-least-once answer
   *  replay from minting a second container. */
  executeCreatePlan(input: {
    source_id: string;
    kind: WorkEntityKind;
    plan: PlannedDependencyCreate;
    /** Caller identity for auditing the container write under the user action. */
    identity?: DependencyInvokeIdentity;
  }): Promise<{ ok: true; entity_pk: string } | { ok: false; reason: string }>;
  /** D-192 baseline-admission (S3) — the FAST-TRACK combined-entry admission over a
   *  create PLAN. When `resolveCreateDependencies` returns `plannedCreates` (a
   *  `container_names`-driven create of a NEW container), the caller offers the plan
   *  here BEFORE raising the 6c.2b owner CONFIRM: if the run's OWNER / granting DOOR
   *  contract GRANTS every op in the plan (each `plannedCreate.create_op` + the target
   *  write), the grant IS the standing approval for the WHOLE plan — the container
   *  creates run inline (admitted, in dependency order) and this returns the re-resolved
   *  `createArgs` so the caller proceeds to the target write with NO owner confirm.
   *  Combined-entry / all-or-nothing: EVERY op is grant-checked BEFORE any container is
   *  created (no silent partial). Any ungranted op / no execution source ⇒
   *  `{ ok:false, kind:'not_granted' }` → the caller falls back to the owner CONFIRM (or
   *  the pick surface). A container-create failure ⇒ `{ ok:false, kind:'error' }` (the
   *  already-created containers persist + are idempotent-reused on retry). */
  tryFastTrackCreatePlan(input: {
    source_id: string;
    kind: WorkEntityKind;
    plannedCreates: ReadonlyArray<PlannedDependencyCreate>;
    /** The run's execution source (the S2 admission identity). Absent ⇒ not fast-track. */
    execution_source?: ExecutionSource;
    /** The caller-named containers, replayed into the post-create re-resolve so the
     *  freshly-created containers resolve as picks. */
    named?: Record<string, string>;
  }): Promise<
    | { ok: true; createArgs: Record<string, unknown> }
    | { ok: false; kind: 'not_granted' }
    | { ok: false; kind: 'error'; reason: string }
  >;
}

// ────────────────────────────────────────────────────────────────
// Payload composition — the projection lanes' inverse paths
// ────────────────────────────────────────────────────────────────

/** The final wire key for one pushable field. A graphql field rides as a flat
 *  mutation variable (its write-path name); a REST field nests under `body.` so
 *  the shared composer folds it into the request body tree. */
const pushableWireKey = (
  transport: 'rest' | 'graphql' | 'mcp',
  remotePath: string,
  // D-225 Slice 3 — REST is the odd one out. A graphql variable and an MCP tool
  // argument are both a NAMED argument; only REST nests its fields under a
  // request-body tree. Keyed on `rest` rather than listing the others so a
  // future named-argument transport is right by default instead of silently
  // getting the body prefix.
): string => (transport === 'rest' ? `body.${remotePath}` : remotePath);


/** The maximum |ms-epoch| `Date.prototype.toISOString` can format —
 *  beyond it the Date is invalid and would throw. */
const MAX_EPOCH_MS = 8_640_000_000_000_000;

/** Apply one declared inverse write transform to a canonical patch
 *  value. Failures are config-grade refusals — `prepare` surfaces them
 *  BEFORE any side effect (same posture as `create_required_fields`);
 *  there is deliberately NO verbatim fallback: an unmapped value
 *  pushed verbatim is exactly the silent vendor-vocabulary break the
 *  transform exists to prevent. */
const applyWriteTransform = (
  transform: WorkEntityWriteTransform,
  field: string,
  value: unknown,
): { ok: true; wire_value: unknown } | { ok: false; reason: string } => {
  if (transform.kind === 'vocab') {
    if (typeof value !== 'string') {
      return { ok: false, reason: `'${field}': the declared vocab write transform expects a string value, got ${typeof value}` };
    }
    const mapped = transform.map[value];
    if (mapped === undefined) {
      return {
        ok: false,
        reason: `'${field}': value '${value}' has no declared vendor mapping (write_transforms.${field}.map)`,
      };
    }
    return { ok: true, wire_value: mapped };
  }
  // date_format — canonical dates are ms-epoch numbers.
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_EPOCH_MS) {
    return { ok: false, reason: `'${field}': the declared date_format write transform expects a ms-epoch number, got ${typeof value === 'number' ? String(value) : typeof value}` };
  }
  // 'yyyy-MM-dd' is the only closed format today: the UTC calendar
  // date of the instant (vendor date-only fields carry no meaningful
  // time component — Salesforce: "the timestamp is not relevant").
  return { ok: true, wire_value: new Date(value).toISOString().slice(0, 10) };
};

// ────────────────────────────────────────────────────────────────
// Vendor-state compare (spec § Conflict model)
// ────────────────────────────────────────────────────────────────

type CompareVerdict =
  | { verdict: 'unchanged' }
  /** Vendor moved off the base. `conflicting` = dirty fields the
   *  vendor changed to a DIFFERENT value than the patch (a vendor
   *  change that equals the patch value is agreement, not conflict);
   *  empty = disjoint change (merge: push the narrow patch, verify
   *  folds the vendor's fields). Known residue: preview-lane fields
   *  compare at CLAMPED fidelity here — a vendor edit past the clamp
   *  that leaves the clamped text equal reads as "did not move" (the
   *  deliberate P4b disjoint-merge posture over bounded meta; the
   *  token-moved guard below covers the hash-equal case). */
  | { verdict: 'changed'; conflicting: string[]; projected: ProjectedWorkEntityUpsert }
  /** Vendor moved off the base (or has no comparable version) and the
   *  current record did not project — field-level comparison is
   *  unavailable; the declared `stale_write` policy decides. */
  | { verdict: 'changed_unknown' };

const scalarEq = (a: unknown, b: unknown): boolean => a === b;

/** D-192 — one canonical value at the fidelity the VENDOR can actually express
 *  it. A field with a declared `write_transforms` inverse is compared on the
 *  WIRE: a `date`-typed vendor field cannot carry sub-day precision, so two ms
 *  instants on the same UTC calendar date are the SAME value to the vendor (an
 *  Asana `due_at` written as `due_on` re-reads as midnight — an exact-ms compare
 *  would false-fail EVERY Asana write). A value the transform cannot map falls
 *  back to its canonical form, so a mismatch fails toward the declared policy
 *  rather than silently passing.
 *
 *  Shared by the pre-write conflict compare (`compareVendorState`) and the
 *  post-write verify (`unlandedPushedFields`) — ONE comparison semantics, two
 *  call sites. A verify that compared differently from the conflict check would
 *  contradict it on exactly the lossy fields both exist to protect. */
const atWireFidelity = (
  declaration: KernelWorkEntitySourceDeclaration,
  field: string,
  v: unknown,
): unknown => {
  const transform = declaration.write_transforms?.[field];
  if (transform === undefined || v === undefined || v === null) return v;
  const t = applyWriteTransform(transform, field, v);
  return t.ok ? t.wire_value : v;
};

/** D-192 — ASSERT the write landed. Returns the pushed fields that provably did
 *  NOT, i.e. the fields the vendor NEVER MOVED and does not hold our value for.
 *
 *  This is the guard the post-write "verify" never had. A mis-declared
 *  `write_paths` entry (`{ title: 'type' }`) writes the user's value into the
 *  WRONG vendor field: the vendor's `title` source path then re-projects
 *  UNCHANGED, `composeVerifiedUpsert` lets that stale vendor value WIN over the
 *  user's edit, `clearPendingWrite` fires, and the outcome reports
 *  `verified: true` — a corrupted vendor record, a silently reverted local edit,
 *  and a green result.
 *
 *  ⚠ The test is "did the field MOVE", NOT "does the vendor echo our exact
 *  bytes". A vendor legitimately NORMALISES what it accepts — trimming,
 *  truncating, title-casing, applying a template, stripping markup — and folding
 *  that normalised value back is the whole point of the verify (a shipped
 *  regression test pushes 'Local title' and asserts the vendor's
 *  'Vendor accepted title' wins). Demanding an exact echo would false-fail every
 *  such vendor. So:
 *
 *    vendor == pushed          → landed exactly.
 *    vendor != prior           → the vendor MOVED the field: accepted, then
 *                                normalised (or a concurrent edit). Fold it.
 *    vendor == prior != pushed → the field NEVER MOVED and does not hold our
 *                                value ⇒ THE WRITE DID NOT LAND. Fail loud.
 *
 *  The third case is exactly a mis-mapped write path — and also a vendor that
 *  silently ignores a field we declared writable but which is actually read-only.
 *  Both are DECLARATION bugs and both must fail, not fold.
 *
 *  Compared at wire fidelity (§atWireFidelity) so a date-typed vendor field does
 *  not false-fail on sub-day precision. `wire_value` is already the wire form —
 *  never transform it twice. */
const unlandedPushedFields = (
  prepared: WorkEntityVendorWritePrepared,
  target: WorkEntityVendorWriteTarget,
  projected: ProjectedWorkEntityUpsert,
): string[] => {
  const { declaration } = prepared;
  const unlanded: string[] = [];
  for (const { field, wire_value } of prepared.pushable) {
    const vendorVal = atWireFidelity(
      declaration,
      field,
      projectedFieldValue(projected, declaration, field),
    );
    if (scalarEq(vendorVal, wire_value)) continue; // landed exactly
    const priorVal = atWireFidelity(
      declaration,
      field,
      priorFieldValue(target.prior, declaration, field),
    );
    if (!scalarEq(vendorVal, priorVal)) continue; // vendor moved it (normalised) — fold
    unlanded.push(field); // never moved, and does not hold our value
  }
  return unlanded;
};

/** The vendor-current value of one projection-lane field on a
 *  projected upsert (canonical column or `preview.<field>` blob
 *  entry). */
const projectedFieldValue = (
  projected: ProjectedWorkEntityUpsert,
  declaration: KernelWorkEntitySourceDeclaration,
  field: string,
): unknown => {
  if (field in declaration.projection.canonical) {
    return (projected.write as unknown as Record<string, unknown>)[field];
  }
  const blob = projected.write.source_extension_blob;
  const preview = blob !== null && typeof blob === 'object' && !Array.isArray(blob)
    ? (blob as Record<string, unknown>).preview
    : undefined;
  return preview !== null && typeof preview === 'object' && !Array.isArray(preview)
    ? (preview as Record<string, unknown>)[field]
    : undefined;
};

/** The local row's value of the same field (the read-before-write
 *  BASE — the pre-edit row mirrors the last-synced vendor state). */
const priorFieldValue = (
  prior: Task | Project | Note,
  declaration: KernelWorkEntitySourceDeclaration,
  field: string,
): unknown => {
  if (field in declaration.projection.canonical) {
    return (prior as unknown as Record<string, unknown>)[field];
  }
  const blob = prior.source_extension_blob;
  const preview = blob !== null && typeof blob === 'object' && !Array.isArray(blob)
    ? (blob as Record<string, unknown>).preview
    : undefined;
  return preview !== null && typeof preview === 'object' && !Array.isArray(preview)
    ? (preview as Record<string, unknown>)[field]
    : undefined;
};

const compareVendorState = (
  prepared: WorkEntityVendorWritePrepared,
  prior: Task | Project | Note,
  vendorRaw: Record<string, unknown>,
): CompareVerdict => {
  const { declaration } = prepared;
  const currentToken = workEntitySourceVersionToken(declaration.remote.version, vendorRaw);
  const baseToken = prior.source_version_token;
  if (currentToken !== undefined && baseToken !== undefined && currentToken === baseToken) {
    return { verdict: 'unchanged' };
  }
  const projected = projectWorkEntitySourceRow({
    declaration,
    source_id: prepared.source_id,
    connection_name: prepared.connection_name,
    source_record_id: prior.source_record_id ?? '',
    raw: vendorRaw,
  });
  if (!projected.ok) return { verdict: 'changed_unknown' };
  if (
    prior.source_record_hash !== undefined
    && projected.upsert.write.source_record_hash === prior.source_record_hash
  ) {
    // The stored hash covers only the BOUNDED lanes (canonical +
    // clamped preview/extension). When the vendor's own version token
    // PROVABLY moved and the patch pushes a preview-lane field, hash
    // equality is not proof the field is unchanged — the vendor may
    // have edited past the preview clamp, and a push would overwrite
    // text the mirror never had at full fidelity (codex P6 fold).
    // Fall to the declared `stale_write` policy instead of a silent
    // overwrite. Canonical-only pushes keep the fast path: canonical
    // fields participate in the hash at full fidelity.
    const tokenMoved =
      currentToken !== undefined && baseToken !== undefined && currentToken !== baseToken;
    const pushesPreviewLane = prepared.pushable.some(
      ({ field }) => !(field in declaration.projection.canonical),
    );
    if (tokenMoved && pushesPreviewLane) return { verdict: 'changed_unknown' };
    return { verdict: 'unchanged' };
  }
  const conflicting: string[] = [];
  for (const { field, wire_value } of prepared.pushable) {
    // Fields with a declared inverse transform compare at WIRE
    // fidelity: a `date`-typed vendor field cannot express sub-day
    // differences, so two ms instants on the same UTC calendar date
    // are the SAME value to the vendor — a local-picker `due_at`
    // against the vendor's midnight-projected date must read as
    // agreement, not conflict (codex MEDIUM). Untransformed fields
    // compare canonically as before (`wire_value` === the canonical
    // patch value there). A side the transform cannot map falls back
    // to its canonical value — a mismatch then fails TOWARD conflict
    // (the declared manual_merge), never a silent overwrite.
    const vendorVal = atWireFidelity(
      declaration,
      field,
      projectedFieldValue(projected.upsert, declaration, field),
    );
    const baseVal = atWireFidelity(declaration, field, priorFieldValue(prior, declaration, field));
    if (scalarEq(vendorVal, baseVal)) continue; // vendor did not move this field
    if (scalarEq(vendorVal, wire_value)) continue; // vendor already holds the patch value — agreement
    conflicting.push(field);
  }
  return { verdict: 'changed', conflicting, projected: projected.upsert };
};

// ────────────────────────────────────────────────────────────────
// Verified-upsert composition — vendor canonical result + preserved
// local-only fields
// ────────────────────────────────────────────────────────────────

/** Compose the post-write mirror upsert: the projected vendor write
 *  (canonical lanes + identity/version fields + extension blob) with
 *  the CURRENT row's local-only fields preserved. The sync cycle's
 *  overwrite-by-design posture would clobber fields the dispatcher
 *  wrote seconds earlier (a title push must not NULL the local
 *  `parent_project_id` set in the same edit) — the verify rewrite is
 *  scoped to the vendor-owned lanes:
 *    - projection-DECLARED canonical fields: vendor result wins
 *      (including absence — parity with sync);
 *    - undeclared canonical fields + FK/relationship fields + the
 *      canonical long-body column: preserved from `current` (sync
 *      never populates them);
 *    - `sync_state` / `conflict_policy`: preserved (a user-set row
 *      policy survives its own write's verification). */
const composeVerifiedUpsert = (
  declaration: KernelWorkEntitySourceDeclaration,
  current: Task | Project | Note,
  projected: ProjectedWorkEntityUpsert,
): ProjectedWorkEntityUpsert => {
  const declared = new Set(Object.keys(declaration.projection.canonical));
  if (projected.kind === 'task') {
    const cur = current as Task;
    const write: TaskWriteInput & { source_record_id: string } = { ...projected.write };
    if (cur.body !== undefined) write.body = cur.body;
    if (!declared.has('done')) write.done = cur.done;
    if (!declared.has('completed_at') && cur.completed_at !== undefined) write.completed_at = cur.completed_at;
    if (!declared.has('state') && cur.state !== undefined) write.state = cur.state;
    if (!declared.has('progress') && cur.progress !== undefined) write.progress = cur.progress;
    if (!declared.has('due_at') && cur.due_at !== undefined) write.due_at = cur.due_at;
    if (!declared.has('priority') && cur.priority !== undefined) write.priority = cur.priority;
    if (cur.assigned_contact_id !== undefined) write.assigned_contact_id = cur.assigned_contact_id;
    if (cur.parent_calendar_event_id !== undefined) write.parent_calendar_event_id = cur.parent_calendar_event_id;
    if (cur.linked_mail_thread_id !== undefined) write.linked_mail_thread_id = cur.linked_mail_thread_id;
    if (cur.parent_project_id !== undefined) write.parent_project_id = cur.parent_project_id;
    if (cur.blocks_task_ids !== undefined) write.blocks_task_ids = cur.blocks_task_ids;
    write.sync_state = cur.sync_state;
    write.conflict_policy = cur.conflict_policy;
    return { kind: 'task', write };
  }
  if (projected.kind === 'note') {
    const cur = current as Note;
    const write: NoteWriteInput & { source_record_id: string } = { ...projected.write };
    // The canonical long-body column is local-only on a meta Source
    // (the projector writes `''`) — the just-written local body must
    // survive its own write's verification.
    write.body = cur.body;
    if (!declared.has('title') && cur.title !== undefined) write.title = cur.title;
    write.related_contact_ids = cur.related_contact_ids;
    write.related_calendar_event_ids = cur.related_calendar_event_ids;
    write.related_mail_thread_ids = cur.related_mail_thread_ids;
    write.related_project_ids = cur.related_project_ids;
    // A verify rewrite is not a user action (§ A.1.2).
    write.last_user_action_at = cur.last_user_action_at;
    write.sync_state = cur.sync_state;
    write.conflict_policy = cur.conflict_policy;
    return { kind: 'note', write };
  }
  const cur = current as Project;
  const write: ProjectWriteInput & { source_record_id: string } = { ...projected.write };
  if (cur.description !== undefined) write.description = cur.description;
  if (!declared.has('state') && cur.state !== undefined) write.state = cur.state;
  if (!declared.has('target_completion_at') && cur.target_completion_at !== undefined) {
    write.target_completion_at = cur.target_completion_at;
  }
  if (cur.related_contact_ids !== undefined) write.related_contact_ids = cur.related_contact_ids;
  if (cur.parent_project_id !== undefined) write.parent_project_id = cur.parent_project_id;
  if (cur.last_activity_at !== undefined) write.last_activity_at = cur.last_activity_at;
  write.sync_state = cur.sync_state;
  write.conflict_policy = cur.conflict_policy;
  return { kind: 'project', write };
};

// ────────────────────────────────────────────────────────────────
// Single-record targeted read
// ────────────────────────────────────────────────────────────────

/** Extract the single-record envelope: the op-level `result_path` when
 *  declared, else the response root. Returns null when no plain record
 *  object sits there. */
const extractRecord = (
  raw: unknown,
  resultPath: string | undefined,
): Record<string, unknown> | null => {
  const at = resultPath !== undefined && resultPath.length > 0
    ? getByDotPath(raw, `result.${resultPath}`)
    : getByDotPath(raw, 'result');
  return at !== null && typeof at === 'object' && !Array.isArray(at)
    ? (at as Record<string, unknown>)
    : null;
};

export type WorkEntityTargetedReadOutcome =
  | { ok: true; record: Record<string, unknown> }
  | { ok: false; kind: 'config' | 'policy' | 'error' | 'unavailable'; reason: string };

/** The dep subset a targeted READ needs — the read-resolution consumers
 *  (chat/MCP work-entity read tools) construct this without the write
 *  path's mirror/store handles. The full `WorkEntityWriteExecutorDeps`
 *  satisfies it structurally. */
export type WorkEntityTargetedReadDeps = Pick<
  WorkEntityWriteExecutorDeps,
  'fetchDeps' | 'resolveDeclaration' | 'runOperation'
> & {
  /** A targeted read only reads a persist selection (`resolvePersistDependency
   *  ReadArgs`) — `getSelected` suffices. The write path's FULL store satisfies
   *  this structurally; a read-tool caller passes only `getSelected`. */
  dependencyStore?: Pick<SourceDependencyEntityStore, 'getSelected'>;
};

/** Run one gated + audited single-record vendor read for a declared
 *  Source — the primitive the write path's preflight uses, exported
 *  for the read-resolution remote plans (`resolveWorkEntityReadPlan`'s
 *  `remote` action) to consume the same way. Read-tool callers pass
 *  their own synthetic `auditRecipe` so an AI-planned remote read is
 *  audited as a READ, not under the write identity (spec § Read
 *  resolution policy: "audited as connection reads"). */
export const runWorkEntitySourceTargetedRead = async (
  deps: WorkEntityTargetedReadDeps,
  input: {
    prepared: Pick<
      WorkEntityVendorWritePrepared,
      'connection_name' | 'manifest' | 'catalogSlug'
    > & { readOp?: ResolvedOp };
    source_record_id: string;
    stepId?: string;
    auditRecipe?: RecipeDefinition;
    /** D-153 — the dispatching caller's source + honest trigger origin
     *  (read-tool escalations); absent = the background `system`
     *  posture (write preflight/verify). Pass-through to the gated
     *  invoke spine. */
    execution_source?: ExecutionSource;
    trigger_source?: string;
    correlation_id?: string;
  },
): Promise<WorkEntityTargetedReadOutcome> => {
  const { prepared, source_record_id } = input;
  const readOp = prepared.readOp;
  if (readOp === undefined || readOp.binding === undefined) {
    return {
      ok: false,
      kind: 'config',
      reason: 'no read op binding — the declaration must carry op_bindings.read.id_arg',
    };
  }
  const run = deps.runOperation ?? runGatedCatalogOperation;
  const invoked = await run(deps.fetchDeps, {
    connection_name: prepared.connection_name,
    manifest: prepared.manifest,
    catalogSlug: prepared.catalogSlug,
    operationKey: readOp.opKey,
    // op_arg_bindings.read scoping args (e.g. Google Tasks `tasklist`) ride flat
    // next to the id_arg; the id_arg wins any key overlap (a scoping arg must
    // never shadow the record id — a distinct arg key by construction).
    args: { ...(readOp.configArgs ?? {}), [readOp.binding.id_arg]: source_record_id },
    auditRecipe: input.auditRecipe ?? SOURCE_WRITE_RECIPE,
    stepId: input.stepId ?? 'write_preflight',
    ...(input.execution_source !== undefined
      ? { execution_source: input.execution_source }
      : {}),
    ...(input.trigger_source !== undefined
      ? { trigger_source: input.trigger_source }
      : {}),
    ...(input.correlation_id !== undefined
      ? { correlation_id: input.correlation_id }
      : {}),
  });
  if (!invoked.ok) return invoked;
  const record = extractRecord(invoked.raw, readOp.resultPath);
  if (record === null) {
    return {
      ok: false,
      kind: 'error',
      reason:
        `'${readOp.opKey}' returned no record object at `
        + `'result${readOp.resultPath !== undefined ? `.${readOp.resultPath}` : ''}'`,
    };
  }
  return { ok: true, record };
};

// ────────────────────────────────────────────────────────────────
// Executor factory
// ────────────────────────────────────────────────────────────────

/** Resolve one op slot against the declaration + bound catalog.
 *  `complete` falls back to the `update` op + binding when no
 *  dedicated complete op is declared (the kernel-declaration
 *  posture: completion is an update-with-completion-field patch). */
const resolveOp = (
  declaration: KernelWorkEntitySourceDeclaration,
  manifest: IngredientManifest,
  catalogSlug: string,
  slot: WorkEntityTargetedOpSlot | 'create',
): { ok: true; op: ResolvedOp } | { ok: false; reason: string } => {
  let effectiveSlot: WorkEntityTargetedOpSlot | 'create' = slot;
  let opKey = declaration.ops[slot];
  if ((opKey === undefined || opKey === null) && slot === 'complete') {
    effectiveSlot = 'update';
    opKey = declaration.ops.update;
  }
  if (opKey === undefined || opKey === null || opKey.length === 0) {
    return { ok: false, reason: `the declaration names no '${slot}' op — the vendor ${slot} is not supported on this Source` };
  }
  const opRow = manifest.operations?.[opKey];
  if (opRow === undefined) {
    return { ok: false, reason: `catalog '${catalogSlug}' declares no '${opKey}' operation` };
  }
  const binding = effectiveSlot === 'create'
    ? undefined
    : declaration.op_bindings?.[effectiveSlot];
  if (effectiveSlot !== 'create' && (binding === undefined || binding.id_arg.length === 0)) {
    return {
      ok: false,
      reason: `the declaration carries no op_bindings.${effectiveSlot}.id_arg — a targeted '${opKey}' invocation cannot name the vendor record`,
    };
  }
  // The wire transport drives write-arg composition (graphql variables vs REST
  // body). Read off the surface execution binding; anything not graphql (openapi
  // / google_discovery REST bindings) composes the REST body.
  const executesKind = (
    manifest.surfaces?.api?.executes as Record<string, { kind?: string }> | undefined
  )?.[opKey]?.kind;
  // D-225 Slice 3 — mcp joins as a first-class write transport. It composes
  // like graphql (named arguments, no body tree — `pushableWireKey`), so the
  // Slice-1 refusal is retired rather than widened.
  //
  // ⚠ The `rest` fallback stays the default for everything else, which is
  // correct for the REST binding kinds and fail-closed for the realtime ones:
  // a webhook/queue/push binding never reaches here, because
  // `validateWorkEntitySources` refuses a Source op bound to one.
  const transport: 'rest' | 'graphql' | 'mcp' =
    executesKind === 'graphql' ? 'graphql'
      : executesKind === 'mcp' ? 'mcp'
        : 'rest';
  return {
    ok: true,
    op: {
      opKey,
      resultPath: typeof opRow.result_path === 'string' ? opRow.result_path : undefined,
      transport,
      ...(binding !== undefined ? { binding } : {}),
    },
  };
};

/** D-192 — fold a `read`-slot `op_arg_bindings` scoping arg (Google Tasks
 *  `tasklist`) onto a resolved read op, resolved against the connection config.
 *  Both read paths run through here — the read-tool escalation
 *  (`prepareWorkEntitySourceTargetedRead`) and the write path's read-before-write
 *  — so a config-scoped read can never be dispatched from one path with the
 *  scoping arg and the other without. Returns the op UNCHANGED when the Source
 *  declares no `op_arg_bindings.read` (the common single-id case). A bound-but-
 *  unset key config-fails BEFORE the read (never a bad request). */
const withReadConfigArgs = (
  op: ResolvedOp,
  declaration: KernelWorkEntitySourceDeclaration,
  connection_config: Record<string, unknown> | undefined,
): { ok: true; op: ResolvedOp } | { ok: false; reason: string } => {
  const resolved = resolveConfigArgBindings(declaration.op_arg_bindings?.read, connection_config);
  if (!resolved.ok) {
    return {
      ok: false,
      reason:
        `the read op on this Source needs arg '${resolved.arg}' from connection config `
        + `'${resolved.config_key}', which is unset — configure it on the connection`,
    };
  }
  return {
    ok: true,
    op: Object.keys(resolved.args).length > 0 ? { ...op, configArgs: resolved.args } : op,
  };
};

/** The config a targeted read runs against — the read-relevant subset
 *  of the write path's `prepared` handle plus the declaration (the
 *  read-resolution consumers project escalated records through its
 *  `projection`). */
export interface WorkEntityTargetedReadPrepared {
  source_id: string;
  connection_name: string;
  declaration: KernelWorkEntitySourceDeclaration;
  manifest: IngredientManifest;
  catalogSlug: string;
  readOp: ResolvedOp;
}

/** Resolve one Source's targeted-read config: declaration → bound
 *  catalog → declared `read` op + binding. The read twin of the write
 *  path's `prepare`, minus the write-only gates — a `read_only`
 *  declared Source (`sync.mode: 'read'`) serves remote reads fine, and
 *  there is no patch to intersect. Config failures are stable until
 *  enrollment/declaration changes (housekeeping-grade taxonomy), never
 *  thrown. */
export const prepareWorkEntitySourceTargetedRead = (
  deps: Pick<WorkEntityTargetedReadDeps, 'fetchDeps' | 'resolveDeclaration' | 'dependencyStore'>,
  input: { source_id: string },
):
  | { ok: true; prepared: WorkEntityTargetedReadPrepared }
  | { ok: false; kind: 'config'; reason: string } => {
  const { source_id } = input;
  const configFail = (reason: string): { ok: false; kind: 'config'; reason: string } =>
    ({ ok: false, kind: 'config', reason });
  const resolved = deps.resolveDeclaration(source_id);
  if (resolved === null) {
    return configFail(
      `source '${source_id}' has no work-entity Source declaration — targeted vendor reads need a declared sync contract`,
    );
  }
  const { declaration, connection_name, connection_config } = resolved;
  const profile = deps.fetchDeps.profiles.get(connection_name);
  if (profile === null) {
    return configFail(`connection '${connection_name}' has no operation profile (not enrolled?)`);
  }
  const catalogSlug = profile.catalog_slug;
  if (catalogSlug === undefined || catalogSlug.length === 0) {
    return configFail(`connection '${connection_name}' carries no catalog binding`);
  }
  const manifest = deps.fetchDeps.executorConfig.manifests.get(catalogSlug) ?? null;
  if (manifest === null) {
    return configFail(`catalog manifest '${catalogSlug}' is not installed`);
  }
  const readOp = resolveOp(declaration, manifest, catalogSlug, 'read');
  if (!readOp.ok) return configFail(readOp.reason);
  const readWithArgs = withReadConfigArgs(readOp.op, declaration, connection_config);
  if (!readWithArgs.ok) return configFail(readWithArgs.reason);
  // D-192 — a persist dependency that binds the read op (Google Tasks `tasklist`)
  // merges its SELECTED id (established by the sync cycle) into the read args.
  let finalReadOp = readWithArgs.op;
  if (deps.dependencyStore !== undefined) {
    const depRead = resolvePersistDependencyReadArgs(deps.dependencyStore, source_id, declaration);
    if (!depRead.ok) return configFail(depRead.reason);
    if (Object.keys(depRead.readArgs).length > 0) {
      finalReadOp = { ...finalReadOp, configArgs: { ...(finalReadOp.configArgs ?? {}), ...depRead.readArgs } };
    }
  }
  return {
    ok: true,
    prepared: {
      source_id,
      connection_name,
      declaration,
      manifest,
      catalogSlug,
      readOp: finalReadOp,
    },
  };
};

export const createWorkEntitySourceWriteExecutor = (
  deps: WorkEntityWriteExecutorDeps,
): WorkEntitySourceWriteExecutor => {
  const now = deps.now ?? ((): number => Date.now());
  const run = deps.runOperation ?? runGatedCatalogOperation;

  const configFail = (reason: string): { ok: false; kind: 'config'; reason: string } =>
    ({ ok: false, kind: 'config', reason });

  /** Resolve the write context — declaration + bound catalog manifest + connection
   *  config — for a source. The config-fail SET shared by `prepare` and
   *  `resolveCreateDependencies` so create-assist resolution and the write itself
   *  can never resolve a DIFFERENT declaration / catalog. */
  const resolveWriteContext = (
    source_id: string,
    kind: MirrorKind,
  ):
    | {
        ok: true;
        declaration: KernelWorkEntitySourceDeclaration;
        connection_name: string;
        connection_config?: Record<string, unknown>;
        catalogSlug: string;
        manifest: IngredientManifest;
      }
    | { ok: false; reason: string } => {
    const resolved = deps.resolveDeclaration(source_id);
    if (resolved === null) {
      return { ok: false, reason: `source '${source_id}' has no work-entity Source declaration — vendor writes need a declared sync contract` };
    }
    const { declaration, connection_name, connection_config } = resolved;
    if (declaration.kind !== kind) {
      return { ok: false, reason: `source '${source_id}' declares kind '${declaration.kind}', not '${kind}'` };
    }
    if (declaration.sync.mode !== 'read_write') {
      return { ok: false, reason: `source '${source_id}' is declared read_only — vendor writes are not permitted` };
    }
    // Bound catalog resolution — the sync runner's config-fail set.
    const profile = deps.fetchDeps.profiles.get(connection_name);
    if (profile === null) {
      return { ok: false, reason: `connection '${connection_name}' has no operation profile (not enrolled?)` };
    }
    const catalogSlug = profile.catalog_slug;
    if (catalogSlug === undefined || catalogSlug.length === 0) {
      return { ok: false, reason: `connection '${connection_name}' carries no catalog binding` };
    }
    const manifest = deps.fetchDeps.executorConfig.manifests.get(catalogSlug) ?? null;
    if (manifest === null) {
      return { ok: false, reason: `catalog manifest '${catalogSlug}' is not installed` };
    }
    return {
      ok: true, declaration, connection_name, catalogSlug, manifest,
      ...(connection_config !== undefined ? { connection_config } : {}),
    };
  };

  const prepare: WorkEntitySourceWriteExecutor['prepare'] = (input) => {
    const { source_id, operation, patch } = input;
    if (!isWorkEntitySourceDeclarableKind(input.kind)) {
      return configFail(
        `${input.kind} never syncs through the Source mirror substrate`,
      );
    }
    const kind: MirrorKind = input.kind;

    const ctxRes = resolveWriteContext(source_id, kind);
    if (!ctxRes.ok) return configFail(ctxRes.reason);
    const { declaration, connection_name, connection_config, catalogSlug, manifest } = ctxRes;

    // Pushable intersection: patch keys × declared writable fields ×
    // the projection lanes (a writable field always has an inverse
    // path — canonical column mapping or the preview field path).
    // A declared write transform computes the vendor wire value HERE —
    // an unmappable value config-refuses before any side effect (for
    // updates, before the dispatcher's local write).
    const writable = new Set(declaration.writable_fields ?? []);
    const pushable: Array<{
      field: string;
      remote_path: string;
      value: unknown;
      wire_value: unknown;
    }> = [];
    for (const [field, value] of Object.entries(patch)) {
      if (value === undefined || value === null) continue;
      if (!writable.has(field)) continue;
      // The vendor WRITE target: the declared `write_paths` override when the
      // read shape ≠ write shape (Todoist `due.date` read / `due_date` write,
      // or any graphql variable name that differs from the read path), else the
      // field's projection READ lane (HubSpot/Salesforce read and write the same
      // `properties.*` path). A DERIVED canonical lane is a derivation object
      // (`number_equals` CORE #8c or `transform` CORE #8e) and a COALESCED lane
      // (CORE #8d) is a path ARRAY — none is a single vendor path, and the
      // `typeof !== 'string'` guard below (which catches EVERY object/array
      // form) runs BEFORE the `write_paths` override so the override can never
      // re-open what the read-only-in-v1 contract closed (codex #8d adversarial
      // fold: the validator forbids these fields as writables at publish, but
      // kernel constants bypass that gate — a drifted declaration combining a
      // non-string lane + writable_fields + write_paths would otherwise compose
      // a real vendor push). Config-refuse LOUDLY before any side effect —
      // never a silent drop that reads as a local-only write.
      const canonicalLane = declaration.projection.canonical[field];
      if (canonicalLane !== undefined && typeof canonicalLane !== 'string') {
        return configFail(
          `writable field '${field}' on source '${source_id}' is projected by a `
          + 'derivation/coalesce — derived and coalesced canonical fields admit '
          + 'no vendor write path in v1',
        );
      }
      const remote_path =
        declaration.write_paths?.[field]
        ?? canonicalLane
        ?? declaration.projection.preview?.[field]?.field;
      if (remote_path === undefined) continue;
      const transform = declaration.write_transforms?.[field];
      let wire_value: unknown = value;
      if (transform !== undefined) {
        const transformed = applyWriteTransform(transform, field, value);
        if (!transformed.ok) return configFail(transformed.reason);
        wire_value = transformed.wire_value;
      }
      pushable.push({ field, remote_path, value, wire_value });
    }

    if (operation !== 'delete' && pushable.length === 0) {
      if (operation === 'create') {
        return configFail(
          `nothing in the create maps to a declared writable field on source '${source_id}' — a vendor record cannot be composed`,
        );
      }
      return {
        ok: true,
        vendor_relevant: false,
        reason: `the patch touches no declared writable field on source '${source_id}'`,
      };
    }

    // Vendor-required create fields refuse BEFORE any side effect
    // (codex MEDIUM): a create is vendor-FIRST, so a composed payload
    // the vendor rejects (HubSpot task create without `hs_timestamp`)
    // would lose the row entirely — no local write has happened yet.
    // `prepare` runs before the dispatcher's local write, so the
    // refusal is a clean config error naming the missing field.
    const createOpArgs: Record<string, unknown> = {};
    if (operation === 'create') {
      for (const field of declaration.create_required_fields ?? []) {
        if (!pushable.some((entry) => entry.field === field)) {
          return configFail(
            `a vendor create on source '${source_id}' requires '${field}' `
            + '(declaration create_required_fields) — include it or create the '
            + 'row on a local Source',
          );
        }
      }
      // Vendor-required op args that are NOT canonical fields (Linear `teamId`),
      // resolved from the connection config through the SHARED resolver — the
      // SAME own-property + unset semantics as the list/read `op_arg_bindings`,
      // so create and the scoping args can never drift. Refuse BEFORE any side
      // effect when a bound value is absent — a create is vendor-FIRST, so a
      // payload the vendor rejects would lose the row entirely.
      const createArgs = resolveConfigArgBindings(declaration.create_arg_bindings, connection_config);
      if (!createArgs.ok) {
        return configFail(
          `a vendor create on source '${source_id}' requires op arg '${createArgs.arg}' from `
          + `connection config '${createArgs.config_key}', which is unset — configure it on the connection`,
        );
      }
      Object.assign(createOpArgs, createArgs.args);

      // D-192 source-dependency create args — the SAME stored container selection
      // that scopes the sync walk also attributes the new record (Asana `workspace`
      // → `body.data.workspace`). Read-only from the selection the sync cycle
      // established; a create-bound dep with no selection config-refuses BEFORE any
      // side effect (the vendor create needs its container). Skipped when no
      // dependency store is wired (byte-identical to pre-D-192).
      if (deps.dependencyStore !== undefined) {
        const persistCreate = resolvePersistDependencyCreateArgs(deps.dependencyStore, source_id, declaration);
        if (!persistCreate.ok) return configFail(persistCreate.reason);
        for (const [k, v] of Object.entries(persistCreate.createArgs)) {
          if (Object.prototype.hasOwnProperty.call(createOpArgs, k)) {
            return configFail(
              `create op arg '${k}' on source '${source_id}' is bound by both a config binding and a source dependency — one authority per arg`,
            );
          }
          createOpArgs[k] = v;
        }
      }

      // Prompt-resolved container ids (a chat-named project → `body.data.projects`),
      // computed by the create-assist preflight and passed in. Last layer; a
      // collision with a config/persist arg is an authoring conflict.
      for (const [k, v] of Object.entries(input.dependencyCreateArgs ?? {})) {
        if (Object.prototype.hasOwnProperty.call(createOpArgs, k)) {
          return configFail(
            `create op arg '${k}' on source '${source_id}' is bound by both a source dependency and another create-arg source — one authority per arg`,
          );
        }
        createOpArgs[k] = v;
      }
    }

    const writeSlot = operation === 'create' ? 'create' : operation;
    const writeResolved = resolveOp(declaration, manifest, catalogSlug, writeSlot);
    if (!writeResolved.ok) return configFail(writeResolved.reason);
    let writeOp = writeResolved.op;

    // D-192 — connection-config args for a TARGETED WRITE. These are the write
    // sibling of `withReadConfigArgs`: a peer/container scope must reach the
    // bound operation before the id and narrow patch are composed. Resolve at
    // prepare time while the connection config is in hand and fail before the
    // local write when a required value is unset.
    if (operation !== 'create') {
      const writeConfigSlot =
        operation === 'complete'
        && (declaration.ops.complete === undefined || declaration.ops.complete === null)
          ? 'update'
          : operation;
      const writeArgs = resolveConfigArgBindings(
        declaration.op_arg_bindings?.[writeConfigSlot],
        connection_config,
      );
      if (!writeArgs.ok) {
        return configFail(
          `the ${writeConfigSlot} op on source '${source_id}' needs arg '${writeArgs.arg}' from `
          + `connection config '${writeArgs.config_key}', which is unset — configure it on the connection`,
        );
      }
      if (Object.keys(writeArgs.args).length > 0) {
        writeOp = { ...writeOp, configArgs: writeArgs.args };
      }
    }

    // D-192 — source-dependency container args for a TARGETED WRITE (update / delete /
    // complete). MS To Do's task lives under a `todoTaskListId`; its update PATCHes
    // `/lists/{list}/tasks/{task}`, so the SAME stored list id that scopes the sync
    // walk + read must ride the write op. Mirrors the create path's persist-dep
    // resolution (create keeps its own `createOpArgs` channel above); folded into
    // `writeOp.configArgs`, which the dispatch merges flat next to the id_arg +
    // precondition. Skipped when no dependency store is wired — byte-identical to the
    // container-less HubSpot/Salesforce write path.
    if (operation !== 'create' && deps.dependencyStore !== undefined) {
      // `complete` with no dedicated `ops.complete` dispatches through the UPDATE op +
      // binding (resolveOp's documented fallback), so its container binds live under
      // the `update` slot. Resolve for the EFFECTIVE slot — a complete-via-update
      // fallback that looked up `complete` binds would drop the container arg and 404
      // (Codex P2).
      const writeBindSlot =
        operation === 'complete'
        && (declaration.ops.complete === undefined || declaration.ops.complete === null)
          ? 'update'
          : operation;
      const depWrite = resolvePersistDependencyWriteArgs(deps.dependencyStore, source_id, declaration, writeBindSlot);
      if (!depWrite.ok) return configFail(depWrite.reason);
      if (Object.keys(depWrite.args).length > 0) {
        for (const key of Object.keys(depWrite.args)) {
          if (Object.prototype.hasOwnProperty.call(writeOp.configArgs ?? {}, key)) {
            return configFail(
              `write op arg '${key}' on source '${source_id}' is bound by both a config binding and a source dependency — one authority per arg`,
            );
          }
        }
        writeOp = { ...writeOp, configArgs: { ...(writeOp.configArgs ?? {}), ...depWrite.args } };
      }
    }

    // A targeted write's record id, conditional token, and narrow patch are
    // composed by the executor itself. Connection/dependency scope args must
    // never claim one of those same wire keys: `composeWireArgs` would refuse
    // the duplicate only during dispatch, after the dispatcher has already
    // committed the local edit and staged a pending write. Catch the complete
    // merged config-arg set here so even kernel-authored declarations that did
    // not pass through the publish validator fail before any local side effect.
    if (operation !== 'create') {
      const binding = writeOp.binding!; // resolveOp requires targeted bindings.
      const ownedArgs = new Map<string, string>([
        [binding.id_arg, `record id argument '${binding.id_arg}'`],
      ]);
      if (binding.precondition_arg !== undefined) {
        ownedArgs.set(
          binding.precondition_arg,
          `conditional-write argument '${binding.precondition_arg}'`,
        );
      }
      for (const entry of pushable) {
        const wireKey = pushableWireKey(writeOp.transport, entry.remote_path);
        ownedArgs.set(wireKey, `patch argument '${wireKey}' for field '${entry.field}'`);
      }
      for (const argName of Object.keys(writeOp.configArgs ?? {})) {
        const owner = ownedArgs.get(argName);
        if (owner !== undefined) {
          return configFail(
            `write op config arg '${argName}' on source '${source_id}' collides with ${owner} — `
            + 'scope args must not overwrite targeted-write-owned arguments',
          );
        }
      }
    }

    // D-192 baseline-admission (S2) — the actor-aware contract-grant admission for a
    // vendor CREATE. When the enclosing run's OWNER (`user_self`) or DOOR
    // (`contracted_user`) governing contract GRANTS this vendor write op, the grant IS
    // the standing approval: admit past the op's `'ask'` gate via the SAME
    // `preflight_admitted` channel the create-plan confirm uses (unforgeable, server-
    // derived). Keyed on the RESOLVED declared `operation_id` (the gate + the fetch
    // spine's approved-target both key on it, NOT the short op key — 6c.2c). Create-only
    // + additive: without a wired gate / source it is false and the write degrades as
    // before, so it never LOOSENS a create-plan re-run and never touches update/delete.
    const grantAdmit =
      operation === 'create'
      && input.execution_source !== undefined
      && admitVendorWrite(
        deps.getOpAdmissionGate?.(),
        input.execution_source,
        manifest.operations?.[writeOp.opKey]?.operation_id ?? writeOp.opKey,
      );

    // Mandatory read-before-write (spec § Write policy) — update and
    // complete preflight-read the vendor record; create has no record
    // yet.
    //
    // D-192 — DELETE now resolves the read op too, but only to READ BACK
    // afterwards (`dispatchDelete`): a 2xx is not proof a delete took, and a
    // record that survives it gets resurrected by the next sync. Unlike
    // update/complete the read is NOT mandatory here — a Source with no `read`
    // op / no `op_bindings.read.id_arg` must still be able to delete, it just
    // falls back to trusting the 2xx. So resolution failure leaves `readOp`
    // undefined instead of config-failing the whole delete.
    let readOp: ResolvedOp | undefined;
    const readIsMandatory = operation === 'update' || operation === 'complete';
    if (readIsMandatory || operation === 'delete') {
      const resolvedRead = resolveOp(declaration, manifest, catalogSlug, 'read');
      if (!resolvedRead.ok) {
        // DELETE: no read op ⇒ no read-back, fall back to the 2xx. NOT fatal —
        // a delete never needed a read op before and must not start needing one.
        if (readIsMandatory) return configFail(resolvedRead.reason);
      } else {
        // A config-scoped read (Google Tasks `tasklist`) needs the same scoping arg
        // on the read-before-write preflight as the read-tool escalation.
        const readWithArgs = withReadConfigArgs(resolvedRead.op, declaration, connection_config);
        if (!readWithArgs.ok) {
          if (readIsMandatory) return configFail(readWithArgs.reason);
        } else {
          readOp = readWithArgs.op;
          // Source-dependency container reads (MS To Do `todoTaskListId`) — the write
          // path's read-before-write needs the same live-picked container scoping the
          // sync walk + read tool resolve. `withReadConfigArgs` above covers the static
          // `op_arg_bindings.read`; this covers the source-dependency selection. Both
          // fold into `readOp.configArgs` (the targeted read rides them flat next to the
          // id_arg). Without this a container-scoped read_write vendor's preflight read
          // would drop the container path token and 404 before the write ever ran.
          if (deps.dependencyStore !== undefined) {
            const depRead = resolvePersistDependencyReadArgs(deps.dependencyStore, source_id, declaration);
            if (!depRead.ok) {
              if (readIsMandatory) return configFail(depRead.reason);
              // DELETE: the read cannot be container-scoped ⇒ drop the read-back
              // rather than fire an unscoped read (which would 404 and prove
              // nothing) or fail a delete that used to work.
              readOp = undefined;
            } else if (Object.keys(depRead.readArgs).length > 0) {
              readOp = { ...readOp, configArgs: { ...(readOp.configArgs ?? {}), ...depRead.readArgs } };
            }
          }
        }
      }
    }

    return {
      ok: true,
      vendor_relevant: true,
      prepared: {
        source_id,
        connection_name,
        kind,
        operation,
        declaration,
        manifest,
        catalogSlug,
        pushable,
        ...(readOp !== undefined ? { readOp } : {}),
        writeOp,
        ...(Object.keys(createOpArgs).length > 0 ? { createOpArgs } : {}),
        // Create-only admission — EITHER a re-run write the create-plan / container-pick
        // confirm already approved (`input.preadmitted`), OR the S2 actor-aware
        // contract-grant admission (`grantAdmit`). Both resolve to the SAME
        // `preflight_admitted` the gate honors; `dispatchCreate` threads it to the invoke.
        ...(operation === 'create' && (input.preadmitted === true || grantAdmit)
          ? { preflight_admitted: true }
          : {}),
      },
    };
  };

  /** Stage / restage the row's pending write. Bases come from the
   *  PRE-edit row (they mirror the last-synced vendor state — local
   *  edits never touch the `source_*` columns, and the sync runner's
   *  dirty-row guard keeps them stable while pending). A re-dispatch
   *  after failure unions the dirty set and increments `attempts`. */
  const stagePending = (
    prepared: WorkEntityVendorWritePrepared,
    target: WorkEntityVendorWriteTarget,
    state: 'pending' | 'awaiting_verify',
  ): void => {
    const priorPending = target.prior.pending_write;
    const dirty = new Set(priorPending?.dirty_fields ?? []);
    for (const { field } of prepared.pushable) dirty.add(field);
    deps.store.stagePendingWrite(prepared.kind, target.local_id, {
      staged_at: priorPending?.staged_at ?? now(),
      operation: prepared.operation,
      dirty_fields: [...dirty],
      base_source_updated_at: target.prior.source_updated_at ?? null,
      base_source_record_hash: target.prior.source_record_hash ?? null,
      base_source_version_token: target.prior.source_version_token ?? null,
      state,
      attempts: (priorPending?.attempts ?? 0) + (state === 'pending' ? 1 : 0),
    });
  };

  /** Store the vendor's canonical result (spec step 7): preserve-
   *  compose over the current row, mirror upsert, clear pending. */
  const storeVerified = (
    prepared: WorkEntityVendorWritePrepared,
    target: WorkEntityVendorWriteTarget,
    projected: ProjectedWorkEntityUpsert,
  ): boolean => {
    try {
      deps.mirror.upsertBySourceIdentity(
        composeVerifiedUpsert(prepared.declaration, target.current, projected),
        now(),
      );
      deps.store.clearPendingWrite(prepared.kind, target.local_id);
      return true;
    } catch {
      // Store-level validation failure — verification is outstanding;
      // the next sync cycle folds the vendor truth and clears.
      return false;
    }
  };

  /** Project a vendor record for THIS row; null when it does not
   *  project or names a different record. */
  const projectFor = (
    prepared: WorkEntityVendorWritePrepared,
    source_record_id: string,
    record: Record<string, unknown>,
  ): ProjectedWorkEntityUpsert | null => {
    const recordId = getByDotPath(record, prepared.declaration.remote.id);
    const key = typeof recordId === 'string' ? recordId : typeof recordId === 'number' ? String(recordId) : '';
    if (key !== source_record_id) return null;
    const projected = projectWorkEntitySourceRow({
      declaration: prepared.declaration,
      source_id: prepared.source_id,
      connection_name: prepared.connection_name,
      source_record_id,
      raw: record,
    });
    return projected.ok ? projected.upsert : null;
  };

  const dispatchCreate = async (
    prepared: WorkEntityVendorWritePrepared,
  ): Promise<WorkEntityVendorWriteDispatchOutcome> => {
    const transport = prepared.writeOp.transport;
    const createOpArgs = prepared.createOpArgs ?? {};
    // Compose the outbound wire args ONCE over the union of pushable body/variable
    // fields + the create-attribute op args (Linear `teamId` flat in the mutation
    // variables; Asana `body.data.workspace` / `body.data.projects` nested in the
    // REST body). The shared composer nests REST body paths — the adapter splits
    // ONLY the first `body.` segment, so a 2-level create arg must arrive already
    // nested — and refuses a wire arg set by more than one source: a create-arg
    // colliding with a writable field's wire key would silently overwrite the
    // user's value in the outbound call while the local row keeps it. A create is
    // vendor-first (no local write yet), so this refuses BEFORE any side effect.
    const composed = composeWireArgs(
      [
        ...prepared.pushable.map(
          (p) => [pushableWireKey(transport, p.remote_path), p.wire_value] as const,
        ),
        ...Object.entries(createOpArgs),
      ],
      transport,
    );
    if (!composed.ok) return { ok: false, kind: 'config', reason: composed.reason, staged: false };
    const invoked = await run(deps.fetchDeps, {
      connection_name: prepared.connection_name,
      manifest: prepared.manifest,
      catalogSlug: prepared.catalogSlug,
      operationKey: prepared.writeOp.opKey,
      args: composed.args,
      auditRecipe: SOURCE_WRITE_RECIPE,
      stepId: 'source_write',
      // D-192 6c.2c — a create-plan / container-pick re-run whose write the user
      // already approved via the confirm: admit past the vendor create op's
      // `'ask'` gate (the standalone spine has no pause path, so an un-admitted
      // `ask` would degrade to a policy fail — orphaning the just-created
      // container). `ask`→admit only; a policy `deny` still blocks.
      ...(prepared.preflight_admitted === true ? { preflight_admitted: true } : {}),
    });
    if (!invoked.ok) {
      return { ok: false, kind: invoked.kind === 'unavailable' ? 'error' : invoked.kind, reason: invoked.reason, staged: false };
    }
    const record = extractRecord(invoked.raw, prepared.writeOp.resultPath);
    // The create RESPONSE may be a different shape than record reads
    // (Salesforce returns `{ id, success, errors }` while its rows
    // carry `Id`) — the declared `create_response_id_field` names the
    // id there; everything downstream (the stamp projection) keeps the
    // read-shape `remote.id`.
    const createIdPath =
      prepared.declaration.remote.create_response_id_field ?? prepared.declaration.remote.id;
    const rawId = record !== null ? getByDotPath(record, createIdPath) : undefined;
    const source_record_id =
      typeof rawId === 'string' ? rawId : typeof rawId === 'number' ? String(rawId) : '';
    if (source_record_id.length === 0) {
      return {
        ok: false,
        kind: 'error',
        reason:
          `'${prepared.writeOp.opKey}' succeeded but the response carries no `
          + `'${createIdPath}' record id — the vendor record may exist unlinked; `
          + 'the next sync cycle will mirror it',
        staged: false,
      };
    }
    // Best-effort vendor-truth stamp — a clean projection gives the
    // local row its conflict-ready base (token + coerced timestamp +
    // hash + extension blob, stored TOGETHER so the stored hash always
    // covers the stored lanes). A partial response projects null → no
    // stamp → the hash-less row re-syncs on the first cycle.
    let stamp: WorkEntityVendorWriteStamp | undefined;
    if (record !== null) {
      const projected = projectFor(prepared, source_record_id, record);
      if (projected !== null) {
        const w = projected.write;
        stamp = {
          ...(w.source_version_token !== undefined ? { source_version_token: w.source_version_token } : {}),
          ...(w.source_updated_at !== undefined ? { source_updated_at: w.source_updated_at } : {}),
          ...(w.source_record_hash !== undefined ? { source_record_hash: w.source_record_hash } : {}),
          ...(w.source_extension_blob !== undefined
            ? { source_extension_blob: w.source_extension_blob as Record<string, unknown> }
            : {}),
        };
      }
    }
    return { ok: true, operation: 'create', source_record_id, ...(stamp !== undefined ? { stamp } : {}) };
  };

  const dispatchDelete = async (
    prepared: WorkEntityVendorWritePrepared,
    target: WorkEntityVendorWriteTarget,
  ): Promise<WorkEntityVendorWriteDispatchOutcome> => {
    const rid = target.prior.source_record_id;
    if (rid === undefined || rid.length === 0) {
      return {
        ok: false,
        kind: 'config',
        reason: 'row carries no source_record_id — the vendor record cannot be targeted',
        staged: false,
      };
    }
    const binding = prepared.writeOp.binding!;
    // Container scoping (MS To Do `list_id`) rides flat next to the id_arg; the
    // id_arg wins any key overlap — a scoping arg must never shadow the record id
    // (distinct arg keys by construction), same posture as the read path.
    const args: Record<string, unknown> = { ...(prepared.writeOp.configArgs ?? {}), [binding.id_arg]: rid };
    if (
      prepared.declaration.write_policy?.conditional_write !== undefined
      && prepared.declaration.write_policy.conditional_write !== 'none'
      && binding.precondition_arg !== undefined
      && target.prior.source_version_token !== undefined
    ) {
      args[binding.precondition_arg] = target.prior.source_version_token;
    }
    const invoked = await run(deps.fetchDeps, {
      connection_name: prepared.connection_name,
      manifest: prepared.manifest,
      catalogSlug: prepared.catalogSlug,
      operationKey: prepared.writeOp.opKey,
      args,
      auditRecipe: SOURCE_WRITE_RECIPE,
      stepId: 'source_write',
    });
    if (!invoked.ok) {
      return { ok: false, kind: invoked.kind === 'unavailable' ? 'error' : invoked.kind, reason: invoked.reason, staged: false };
    }

    // D-192 — ASSERT the delete landed. A 2xx is NOT proof: a vendor may 2xx a
    // SOFT delete (the record stays readable), and a mis-mapped `id_arg` targets
    // nothing while the vendor cheerfully returns 204. Either way the vendor
    // record SURVIVES while we delete locally — and the next sync cycle
    // RESURRECTS it. (`taskDelete` already orders the delete vendor-first for
    // exactly this fear, but ordering alone never checked whether it worked.)
    //
    // This is a REFUTATION, deliberately — it can prove the delete FAILED, and
    // it never claims to prove it succeeded. A read that SUCCEEDS and still
    // returns the record proves the delete did not take. We do NOT invert that
    // and read "the read failed ⇒ the record is gone": the operation outcome
    // carries no HTTP status (`GatedCatalogOperationOutcome` is
    // `{ok:false, kind, reason}`; the adapter's structured `API_NOT_FOUND` is
    // flattened to a message), so a 404 (gone) is indistinguishable from a 500 /
    // auth / network failure (unknown). Inferring deletion from a failed read
    // would fail OPEN on a transient — the exact failure this guard exists to
    // stop. Refuting is enough: BOTH real hazards (a soft delete, and a
    // mis-mapped `id_arg` that targeted nothing) leave the record READABLE.
    //
    // Upgrade path: plumb the adapter's error code / HTTP status through the
    // operation outcome and a 404 becomes a POSITIVE confirmation. Deferred —
    // the engine normalizes error codes, so it needs its own empirical proof.
    if (prepared.readOp?.binding !== undefined) {
      const readBack = await runWorkEntitySourceTargetedRead(deps, {
        prepared,
        source_record_id: rid,
        stepId: 'write_verify',
      });
      if (readBack.ok) {
        return {
          ok: false,
          kind: 'verify_failed',
          reason:
            `the vendor still returns record '${rid}' after '${prepared.writeOp.opKey}'`
            + ' reported success — the delete did not take (a soft delete, or a mis-mapped'
            + ' op_bindings id_arg targeting the wrong record). Refusing to delete locally:'
            + ' the next sync cycle would resurrect it.',
          unlanded_fields: [],
          staged: false,
        };
      }
    }
    return { ok: true, operation: 'delete' };
  };

  const dispatchUpdate = async (
    prepared: WorkEntityVendorWritePrepared,
    target: WorkEntityVendorWriteTarget,
  ): Promise<WorkEntityVendorWriteDispatchOutcome> => {
    const operation = prepared.operation as 'update' | 'complete';
    const rid = target.prior.source_record_id;
    if (rid === undefined || rid.length === 0) {
      return {
        ok: false,
        kind: 'config',
        reason: 'row carries no source_record_id — the vendor record cannot be targeted',
        staged: false,
      };
    }

    // 1 — stage the dirty state (bases at edit time).
    stagePending(prepared, target, 'pending');

    // 2 — mandatory preflight read.
    const read = await runWorkEntitySourceTargetedRead(deps, {
      prepared,
      source_record_id: rid,
    });
    if (!read.ok) {
      return {
        ok: false,
        kind: read.kind === 'unavailable' ? 'error' : read.kind,
        reason: `read-before-write failed: ${read.reason}`,
        staged: true,
      };
    }
    // The record must BE the targeted record before anything compares
    // against it (codex HIGH): a catalog/vendor drift returning a
    // different record would otherwise drive the conflict compare —
    // and the precondition token — off the wrong vendor state, turning
    // a genuinely-conflicted write into a silent overwrite.
    const readId = getByDotPath(read.record, prepared.declaration.remote.id);
    const readKey =
      typeof readId === 'string' ? readId : typeof readId === 'number' ? String(readId) : '';
    if (readKey !== rid) {
      return {
        ok: false,
        kind: 'error',
        reason:
          `read-before-write returned record '${readKey.length > 0 ? readKey : '<no id>'}'`
          + ` — expected '${rid}' (catalog '${prepared.readOp?.opKey ?? 'read'}' drift?)`,
        staged: true,
      };
    }

    // 3 — compare vendor-current version/hash against the staged base.
    // A conflicted/un-comparable state with no declared resolution
    // policy fails SAFE to manual_merge — never an implicit overwrite.
    const cmp = compareVendorState(prepared, target.prior, read.record);
    const policy: WorkEntityConflictResolution | undefined =
      cmp.verdict === 'changed' && cmp.conflicting.length > 0
        ? prepared.declaration.write_policy?.field_conflicts ?? 'manual_merge'
        : cmp.verdict === 'changed_unknown'
          ? prepared.declaration.write_policy?.stale_write ?? 'manual_merge'
          : undefined;

    if (policy === 'manual_merge') {
      // Overlapping (or un-comparable) concurrent edits with no
      // auto-resolution declared — surface as a typed conflict; the
      // pending write stays as the honest dirty marker. (The
      // notification.ask / merge-card resolution surface is the
      // deferred follow-on; v1 resolves by the caller re-reading and
      // re-writing with values that agree with the vendor.)
      const conflicting = cmp.verdict === 'changed' ? cmp.conflicting : [...new Set(prepared.pushable.map((f) => f.field))];
      return {
        ok: false,
        kind: 'conflict',
        reason:
          cmp.verdict === 'changed'
            ? `the vendor record changed the same field(s) since last sync: ${conflicting.join(', ')}`
            : 'the vendor record changed since last sync and could not be field-compared',
        conflicting_fields: conflicting,
        staged: true,
      };
    }
    if (policy === 'source_wins') {
      // The declared policy adopts the vendor state instead of
      // writing. A projectable current record verifies immediately;
      // otherwise `awaiting_verify` lets the next sync cycle fold it.
      if (cmp.verdict === 'changed' && storeVerified(prepared, target, cmp.projected)) {
        return { ok: true, operation, applied: 'vendor_won', verified: true };
      }
      stagePending(prepared, target, 'awaiting_verify');
      return { ok: true, operation, applied: 'vendor_won', verified: false };
    }
    // `unchanged`, disjoint `changed` (merge: push the narrow patch —
    // the verify read folds the vendor's fields), or `recued_wins`.

    // 4 — the narrow write. The id_arg + precondition token ride as flat op args
    // (a REST path token / a graphql `$id` variable) alongside the composed body.
    const transport = prepared.writeOp.transport;
    const binding = prepared.writeOp.binding!;
    const entries: Array<readonly [string, unknown]> = [
      ...prepared.pushable.map(
        (p) => [pushableWireKey(transport, p.remote_path), p.wire_value] as const,
      ),
      // Container scoping (MS To Do `list_id`) rides flat alongside the id_arg + the
      // narrow body patch — a REST path token the composer keeps top-level.
      ...Object.entries(prepared.writeOp.configArgs ?? {}),
      [binding.id_arg, rid] as const,
    ];
    const conditional = prepared.declaration.write_policy?.conditional_write;
    if (conditional !== undefined && conditional !== 'none' && binding.precondition_arg !== undefined) {
      // The vendor-CURRENT token asserts the state the compare just
      // accepted (closing the preflight→write race); the staged base
      // token only stands in when the read exposed none.
      const token =
        workEntitySourceVersionToken(prepared.declaration.remote.version, read.record)
        ?? target.prior.source_version_token;
      if (token !== undefined) entries.push([binding.precondition_arg, token] as const);
    }
    const composed = composeWireArgs(entries, transport);
    if (!composed.ok) return { ok: false, kind: 'config', reason: composed.reason, staged: true };
    const written = await run(deps.fetchDeps, {
      connection_name: prepared.connection_name,
      manifest: prepared.manifest,
      catalogSlug: prepared.catalogSlug,
      operationKey: prepared.writeOp.opKey,
      args: composed.args,
      auditRecipe: SOURCE_WRITE_RECIPE,
      stepId: 'source_write',
    });
    if (!written.ok) {
      return { ok: false, kind: written.kind === 'unavailable' ? 'error' : written.kind, reason: written.reason, staged: true };
    }

    // 5 — post-write verify: consume the write response when it
    // carries the full record, else re-read.
    let projected: ProjectedWorkEntityUpsert | null = null;
    const responseRecord = extractRecord(written.raw, prepared.writeOp.resultPath);
    if (responseRecord !== null) projected = projectFor(prepared, rid, responseRecord);
    if (projected === null) {
      const verifyRead = await runWorkEntitySourceTargetedRead(deps, {
        prepared,
        source_record_id: rid,
        stepId: 'write_verify',
      });
      if (verifyRead.ok) projected = projectFor(prepared, rid, verifyRead.record);
    }
    // D-192 — ASSERT before folding. `composeVerifiedUpsert` lets the VENDOR's
    // value win for every declared canonical field, so folding an unasserted
    // projection would overwrite the user's edit with the vendor's stale value
    // and report success. Prove the push actually landed first.
    if (projected !== null) {
      const unlanded = unlandedPushedFields(prepared, target, projected);
      if (unlanded.length > 0) {
        // The vendor does NOT hold what we pushed. Fail LOUD and, critically, do
        // NOTHING else: skipping `storeVerified` is what preserves the user's
        // edit (it is the call that folds the vendor's stale value over the row
        // AND clears the pending write). Step 1 already staged the row `pending`
        // (hands-off) before the write, so the local edit simply stands as honest
        // dirty state — no re-stage needed.
        return {
          ok: false,
          kind: 'verify_failed',
          reason:
            `the vendor does not hold the pushed value for ${unlanded.map((f) => `'${f}'`).join(', ')}`
            + ` after '${prepared.writeOp.opKey}' reported success — the write did not land`
            + ' (check the declaration\'s write_paths / op_bindings.id_arg: a mis-mapped path writes'
            + ' into the wrong vendor field). The local edit is kept as a pending write.',
          unlanded_fields: unlanded,
          staged: true,
        };
      }
      if (storeVerified(prepared, target, projected)) {
        return { ok: true, operation, applied: 'pushed', verified: true };
      }
    }
    // The write landed but verification is outstanding — the next
    // sync cycle folds the vendor truth and clears the state.
    stagePending(prepared, target, 'awaiting_verify');
    return { ok: true, operation, applied: 'pushed', verified: false };
  };

  const dispatch: WorkEntitySourceWriteExecutor['dispatch'] = async (
    prepared,
    target,
  ) => {
    let outcome: WorkEntityVendorWriteDispatchOutcome;
    if (prepared.operation === 'create') {
      outcome = await dispatchCreate(prepared);
    } else if (target === undefined) {
      outcome = {
        ok: false,
        kind: 'config',
        reason: `a '${prepared.operation}' dispatch requires the local target row`,
        staged: false,
      };
    } else if (prepared.operation === 'delete') {
      outcome = await dispatchDelete(prepared, target);
    } else {
      outcome = await dispatchUpdate(prepared, target);
    }

    const context = deps.getDeterministicVerificationContext?.();
    const verifiedPass =
      outcome.ok
      && (outcome.operation === 'update'
        || outcome.operation === 'complete')
      && outcome.applied === 'pushed'
      && outcome.verified;
    const verifiedFailure = !outcome.ok && outcome.kind === 'verify_failed';
    if (
      context
      && deps.recordDeterministicVerification
      && (verifiedPass || verifiedFailure)
    ) {
      const kind = verifiedPass ? 'passed' as const : 'failed' as const;
      const sourceEventId = createHash('sha256')
        .update(JSON.stringify([
          context.session_id,
          context.turn_id,
          prepared.source_id,
          prepared.kind,
          prepared.operation,
          target?.local_id ?? '',
          kind,
        ]))
        .digest('hex');
      try {
        await deps.recordDeterministicVerification({
          session_id: context.session_id,
          turn_id: context.turn_id,
          kind,
          postcondition_key:
            `work_entity_vendor:${prepared.kind}:${prepared.operation}`,
          source_event_id: sourceEventId,
        });
      } catch (error) {
        console.error(
          '[d214] deterministic verification recording failed',
          error,
        );
      }
    }
    return outcome;
  };

  const resolveCreateDependencies: WorkEntitySourceWriteExecutor['resolveCreateDependencies'] =
    async (input) => {
      // No dependency store ⇒ nothing to resolve (byte-identical to pre-Slice-6a);
      // a non-declarable kind never syncs through this substrate.
      if (deps.dependencyStore === undefined || !isWorkEntitySourceDeclarableKind(input.kind)) {
        return { ok: true, createArgs: {}, plannedCreates: [] };
      }
      const ctxRes = resolveWriteContext(input.source_id, input.kind);
      // A read_only / unresolvable source has no create path — the write itself
      // surfaces that config error; the preflight adds nothing.
      if (!ctxRes.ok) return { ok: true, createArgs: {}, plannedCreates: [] };
      const { declaration, connection_name, catalogSlug, manifest } = ctxRes;
      // Fast path: no prompt dependency binds create ⇒ no preflight, no fetch.
      const hasPromptCreate = (declaration.source_dependencies ?? []).some(
        (d) => d.resolve === 'prompt' && d.binds.some((b) => b.op === 'create'),
      );
      if (!hasPromptCreate) return { ok: true, createArgs: {}, plannedCreates: [] };
      // Grant-driven create authorization (Slice 6c Part 3-A): a container's
      // `create_op` may be PLANNED iff it is granted on the connection (∈
      // `allowed_operations`). The gateway remains the enforcer; this pre-check
      // degrades an ungranted create to pick-only rather than planning a create the
      // gate would refuse. An unenrolled connection (no profile) authorizes nothing.
      const allowedOps = new Set(deps.fetchDeps.profiles.get(connection_name)?.allowed_operations ?? []);
      const outcome = await resolvePromptDependencies(
        {
          fetchDeps: deps.fetchDeps,
          store: deps.dependencyStore,
          ...(deps.runOperation ? { runOperation: deps.runOperation } : {}),
        },
        {
          source_id: input.source_id, declaration, connection_name, manifest, catalogSlug,
          isCreateAuthorized: (op) => allowedOps.has(op),
          ...(input.named !== undefined ? { named: input.named } : {}),
          ...(input.identity !== undefined ? { identity: input.identity } : {}),
          now: now(),
        },
        'create',
      );
      // S4 fold — stamp the TARGET write op id onto an ambiguous-container ask so the
      // chat surface can require BOTH the target write AND the container create granted
      // before promising the one-step create (the fast-track admits both; the model-facing
      // copy must too, or it over-promises a create that then falls to not_granted).
      // Resolved the SAME way `tryFastTrackCreatePlan` resolves its target write op.
      if (!outcome.ok && outcome.kind === 'ask') {
        const targetWrite = resolveOp(declaration, manifest, catalogSlug, 'create');
        if (targetWrite.ok) {
          outcome.ask.target_write_op =
            manifest.operations?.[targetWrite.op.opKey]?.operation_id ?? targetWrite.op.opKey;
        }
      }
      return outcome;
    };

  const executeCreatePlan: WorkEntitySourceWriteExecutor['executeCreatePlan'] =
    async (input) => {
      if (deps.dependencyStore === undefined || !isWorkEntitySourceDeclarableKind(input.kind)) {
        return { ok: false, reason: 'no dependency store wired — a container create has nowhere to persist' };
      }
      const ctxRes = resolveWriteContext(input.source_id, input.kind);
      if (!ctxRes.ok) return { ok: false, reason: ctxRes.reason };
      const { connection_name, catalogSlug, manifest } = ctxRes;
      // Idempotency (the answer is at-least-once): if this container was already
      // created + selected by a prior attempt, reuse it instead of minting a
      // duplicate. A plan only exists when NO container matched the name at decide
      // time, so a stored selection carrying the plan's name is this plan's own
      // prior create (an answer replay), not a coincidental pre-existing pick.
      const existing = deps.dependencyStore.getSelected(input.source_id, input.plan.ref);
      if (existing !== null && existing.label === input.plan.name) {
        return { ok: true, entity_pk: existing.entity_pk };
      }
      // Run the gated container WRITE (audited under the caller identity).
      const created = await executePlannedCreate(
        {
          fetchDeps: deps.fetchDeps,
          store: deps.dependencyStore,
          ...(deps.runOperation ? { runOperation: deps.runOperation } : {}),
        },
        {
          connection_name, manifest, catalogSlug,
          ...(input.identity !== undefined ? { identity: input.identity } : {}),
        },
        input.plan,
      );
      if (!created.ok) return created;
      // Persist the created container as the Source's stored selection so the
      // create's re-run auto-resolves it as a pick (mirrors container-pick's
      // store.select). `replaceEntities` caches it (select refuses an uncached id);
      // the pruned options re-fetch on the next list.
      deps.dependencyStore.replaceEntities(
        input.source_id,
        input.plan.ref,
        [{ entity_pk: created.entity_pk, label: input.plan.name }],
        { now: now() },
      );
      if (!deps.dependencyStore.select(input.source_id, input.plan.ref, created.entity_pk)) {
        return { ok: false, reason: `created container '${created.entity_pk}' did not persist as the selection for '${input.plan.ref}'` };
      }
      return { ok: true, entity_pk: created.entity_pk };
    };

  const tryFastTrackCreatePlan: WorkEntitySourceWriteExecutor['tryFastTrackCreatePlan'] =
    async (input) => {
      const gate = deps.getOpAdmissionGate?.();
      // No gate / no execution source ⇒ not fast-trackable — fall to the owner CONFIRM
      // (a background / no-source create-plan keeps its human approval). Degrade-preserving.
      if (gate === undefined || input.execution_source === undefined) {
        return { ok: false, kind: 'not_granted' };
      }
      if (input.plannedCreates.length === 0) return { ok: true, createArgs: {} };
      // A commitment never syncs through this substrate (so never produces a plan);
      // narrow to MirrorKind for `resolveWriteContext` and fail-closed if reached.
      if (!isWorkEntitySourceDeclarableKind(input.kind)) {
        return { ok: false, kind: 'not_granted' };
      }
      const source = input.execution_source;
      const ctxRes = resolveWriteContext(input.source_id, input.kind);
      if (!ctxRes.ok) return { ok: false, kind: 'error', reason: ctxRes.reason };
      const { declaration, manifest, catalogSlug } = ctxRes;

      // Grant-check EVERY op in the plan BEFORE creating anything (combined-entry,
      // all-or-nothing — no silent partial): the TARGET write op + each
      // `plannedCreate.create_op`, each resolved to its declared `operation_id` (the id
      // `isOpGranted` + the fetch spine's approved-target key on — the 6c.2c lesson).
      const targetWrite = resolveOp(declaration, manifest, catalogSlug, 'create');
      if (!targetWrite.ok) return { ok: false, kind: 'error', reason: targetWrite.reason };
      const planOpIds: string[] = [
        manifest.operations?.[targetWrite.op.opKey]?.operation_id ?? targetWrite.op.opKey,
        ...input.plannedCreates.map(
          (p) => manifest.operations?.[p.create_op]?.operation_id ?? p.create_op,
        ),
      ];
      for (const opId of planOpIds) {
        // ANY ungranted op ⇒ NOT fast-track — the whole plan falls to the owner CONFIRM
        // (no container is created). `admitVendorWrite` also excludes system/anonymous.
        if (!admitVendorWrite(gate, source, opId)) return { ok: false, kind: 'not_granted' };
      }

      // All granted ⇒ EXECUTE the container creates in dependency order (a later plan may
      // scope on an earlier one). `executeCreatePlan` admits the gated container write +
      // persists the created id as the Source's selection (idempotent per (source, ref,
      // name)); audited under the ACTING source (not a synthetic confirm identity).
      for (const plan of input.plannedCreates) {
        const created = await executeCreatePlan({
          source_id: input.source_id,
          kind: input.kind,
          plan,
          identity: { execution_source: source },
        });
        if (!created.ok) return { ok: false, kind: 'error', reason: created.reason };
      }

      // Re-resolve with the SAME named map — the freshly-created + persisted containers
      // now resolve as PICKS → the bound create args, exactly as the create-plan re-run
      // does. A residual plan / ask here means a container did not persist as expected;
      // fail to `error` (the containers exist, so a retry is idempotent) rather than
      // silently degrading the write.
      const reresolved = await resolveCreateDependencies({
        source_id: input.source_id,
        kind: input.kind,
        ...(input.named !== undefined ? { named: input.named } : {}),
      });
      if (!reresolved.ok) {
        return {
          ok: false,
          kind: 'error',
          reason: reresolved.kind === 'ask'
            ? 'containers created but a dependency is still ambiguous on re-resolution'
            : reresolved.reason,
        };
      }
      if (reresolved.plannedCreates.length > 0) {
        return { ok: false, kind: 'error', reason: 'containers created but re-resolution did not bind them' };
      }
      return { ok: true, createArgs: reresolved.createArgs };
    };

  return {
    prepare, dispatch, resolveCreateDependencies, executeCreatePlan, tryFastTrackCreatePlan,
  };
};
