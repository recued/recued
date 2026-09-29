/** D-145 PA3 — Kernel CRUD ingredient dispatcher composition.
 *
 *  Server-side handler factory for the 14 work-entity write
 *  ingredients (`task-create` / `task-update` / `task-delete` /
 *  `task-mark-done` + the note / commitment / project parallels).
 *  The kernel adapter (in `packages/ingredients/src/kernel.ts`) does
 *  shape validation and routes each slug to its dispatcher slot; this
 *  module composes those slots from the storage layer + Source primitive
 *  + commitment state-machine validators.
 *
 *  Three substrate concerns live here:
 *
 *  1. **Source resolution** (§ A.2.2). Every create-ish ingredient
 *     accepts an optional `source_id`. Resolution order:
 *       a. explicit `input.source_id` — validates registered + kind
 *          match through the resolver (typed `unknown_source` /
 *          `kind_source_mismatch` errors).
 *       b. ⛔ DELETED (D-187 Sources half) — there is no per-kind default.
 *          Resolution is `explicit source_id ?? built-in local`.
 *       c. `RECUED_BUILTIN_SOURCE_ID(kind)` as the final fallback —
 *          PA2 auto-registers this on first server init.
 *     Update / delete / lifecycle ingredients inherit `source_id` from
 *     the existing row; cross-Source moves are not supported (a future
 *     `task-move-source` ingredient would carry that intent
 *     explicitly).
 *
 *  2. **Write capability gate** (§ A.2 + PA2 Codex P2 fold; D-192 P4b
 *     redesign). Sources register at `write_capable: false` until the
 *     substrate has proof the underlying provider accepts writes.
 *     Recued built-in is trivially `write_capable: true` (writes go to
 *     local SQLite). Connection-derived Sources route through the
 *     DECLARATION-DRIVEN write executor (`work-entity-write-executor`,
 *     replacing the PA3 `VendorWriteHook` seam — Codex H5) in two
 *     phases: `prepare` runs BEFORE the local write so a structurally
 *     unwritable Source (no declaration / read_only / missing op or
 *     binding / no executor wired) refuses up-front with
 *     `SOURCE_NOT_WRITE_CAPABLE`; `dispatch` runs the vendor
 *     round-trip (read-before-write → narrow patch → post-write
 *     verify → pending-write lifecycle). Update-family dispatchers are
 *     LOCAL-FIRST: the local edit + events land, then the vendor push
 *     runs — a push failure throws but leaves the edit staged as an
 *     honest `pending_write` (spec § Conflict model's dirty-write
 *     state), never rolls the local write back. Create and delete stay
 *     vendor-first (a create needs the vendor-native id before the
 *     local row exists; a local-first delete would be resurrected by
 *     the next sync cycle). The first successful dispatch still flips
 *     `write_capable: true` (the PA2 "first-dispatch capability probe"
 *     — the flip is a side effect of the first success).
 *
 *  3. **Commitment lifecycle state machine** (§ A.1.3). PA1 left
 *     transition validation to PA3; this is where the load-bearing
 *     monetary-commitment invariant lives:
 *       - `pending → fulfilled` / `pending → cancelled` always allowed.
 *       - `expired → fulfilled` only under `escalate_overdue` /
 *         `indefinite` expiry policies (§ A.1.3 "monetary commitments
 *         must NOT silently expire when the deadline passes").
 *       - `expired → cancelled` always allowed.
 *       - terminal lifecycle states (`fulfilled` / `cancelled`) reject
 *         further moves.
 *     `commitment-update` is metadata-only — lifecycle + due_status
 *     stay un-mutated by it; the dedicated `commitment-fulfill` /
 *     `commitment-cancel` ingredients are the only path to lifecycle
 *     transitions.
 *
 *  Spec: D-145 § Phase PA3 + § A.1.3 + § A.2.2. */

import {
  COMMITMENT_CANCEL_FROM_STATES,
  COMMITMENT_FULFILL_ALLOWED_EXPIRY_POLICIES,
  COMMITMENT_FULFILL_FROM_STATES,
  parseQualifiedWorkEntityId,
  qualifyWorkEntityId,
  QualifiedWorkEntityIdError,
  isTaskIdempotencyKey,
  RECUED_BUILTIN_SOURCE_ID,
  taskIdFromIdempotencyKey,
  workEntityIdFromIdempotencyKey,
  WORK_ENTITY_BUS_ENTITY_TYPE,
  WORK_ENTITY_BUS_PLATFORM,
  type Booking,
  type BookingLifecycleState,
  type Commitment,
  type CommitmentDueStatus,
  type ContainerPickDetail,
  type CreatePlanDetail,
  type ExecutionSource,
  type MonetaryValue,
  type Note,
  type PlannedDependencyCreate,
  type Project,
  type SourceRegistration,
  type Task,
  type WorkEntity,
  type WorkEntityKind,
} from '@recued/contracts';
import type { WarehouseEventBus, WarehouseEventKind } from '@recued/warehouse-events';

import type { CascadeEngine } from './storage/enrichment-cascade.js';
import {
  WorkEntityValidationError,
  ZONELESS_DATE_TIME,
  unambiguousDateMs,
  type BookingWriteInput,
  type CommitmentWriteInput,
  type NoteWriteInput,
  type ProjectWriteInput,
  type TaskWriteInput,
  type WorkEntityStore,
} from './storage/work-entity-store.js';
import { classifyCommitmentDueStatus } from './work-entity-due-status-sweep.js';
import { readThroughSourceIds } from './work-entity-read-resolution.js';
import type { WorkEntityResolver } from './work-entity-resolver.js';
import type {
  WorkEntitySourceWriteExecutor,
  WorkEntityReadThroughWriteDispatchOutcome,
  WorkEntityVendorWriteDispatchOutcome,
  WorkEntityVendorWriteOperation,
  WorkEntityVendorWritePrepared,
  WorkEntityVendorWriteStamp,
} from './work-entity-write-executor.js';
import type { ProjectedWorkEntityUpsert } from './work-entity-source-projector.js';
import type { PromptDependencyAsk } from './source-dependency-resolver.js';

/** Thrown when a write is attempted against a Source that has not
 *  proved write-capability (or is structurally unwritable — no
 *  declaration, read_only, missing op/binding, no executor wired).
 *  Raised BEFORE any local write, so a refusal never leaves a silent
 *  local edit. Surfaced via the kernel adapter with a recipe-friendly
 *  code so the recipe layer can branch on capability gaps instead of
 *  swallowing the substrate detail. */
export class WorkEntityWriteCapabilityError extends Error {
  readonly code = 'SOURCE_NOT_WRITE_CAPABLE';
  readonly source_id: string;
  readonly kind: WorkEntityKind;
  constructor(source_id: string, kind: WorkEntityKind, detail?: string) {
    super(
      `Source '${source_id}' is not write-capable for kind '${kind}'.`
        + (detail !== undefined ? ` ${detail}.` : '')
        + ` Connection-derived Sources need a declared read_write sync contract with the`
        + ` matching op + op_bindings; pin a different Source through Settings → Work Entities`
        + ` or complete the Source declaration.`,
    );
    this.name = 'WorkEntityWriteCapabilityError';
    this.source_id = source_id;
    this.kind = kind;
  }
}

/** D-192 Slice 6a — thrown when a create's container dependency (Linear `team`,
 *  an Asana `workspace`) is AMBIGUOUS: more than one option and none named /
 *  stored / a lone auto-pick. The caller must present the choice set and re-run
 *  with the pick.
 *
 *  Slice 6b: TWO consumers read this, one structurally, one directly.
 *   - The **pair-RPC** path (`work_entity.upsert`) catches the CLASS in
 *     `mapCrudError` and reads its typed fields into a `container_pick_required`
 *     rpc error (the webclient renders its own picker from `options`).
 *   - The **chat / MCP** path runs the create inside an engine run, which
 *     swallows a bare throw into a generic step error. So the error also carries
 *     a `container_pick` CARRIER (`ContainerPickDetail`) the engine's step-runner
 *     preserves onto `RecipeError.details.container_pick` (same pattern as
 *     `cli_failure`); `handleExecute` reads it, raises the D-158 pick ask, and
 *     surfaces a terminal `container_pick_required`. */
export class WorkEntityContainerPickRequiredError extends Error {
  readonly code = 'WORK_ENTITY_CONTAINER_PICK_REQUIRED';
  readonly source_id: string;
  readonly kind: WorkEntityKind;
  readonly dependency_ref: string;
  readonly options: ReadonlyArray<{ entity_pk: string; label: string }>;
  readonly can_create: boolean;
  /** S4 — the container's resolved create `operation_id` (if any); mirrored onto
   *  the carrier so the chat catch site can grant-check it. */
  readonly create_op?: string;
  /** S4 fold — the TARGET write's resolved `operation_id`; the catch site requires
   *  it granted TOO before promising the one-step create. */
  readonly target_write_op?: string;
  /** The structural carrier the engine step-runner preserves across the run
   *  seam so the chat/MCP path keeps the choice set (a bare throw would collapse
   *  to a message-only `NETWORK_ERROR`). */
  readonly container_pick: ContainerPickDetail;
  constructor(source_id: string, kind: WorkEntityKind, ask: PromptDependencyAsk) {
    super(
      `Creating a '${kind}' on Source '${source_id}' needs a '${ask.ref}' container `
        + `chosen from ${ask.options.length} option(s): `
        + `${ask.options.map((o) => `${o.label} (${o.entity_pk})`).join(', ')}. `
        + `Re-run the create with the chosen container selected.`,
    );
    this.name = 'WorkEntityContainerPickRequiredError';
    this.source_id = source_id;
    this.kind = kind;
    this.dependency_ref = ask.ref;
    this.options = ask.options;
    this.can_create = ask.can_create;
    if (ask.create_op !== undefined) this.create_op = ask.create_op;
    if (ask.target_write_op !== undefined) this.target_write_op = ask.target_write_op;
    this.container_pick = {
      source_id,
      kind,
      dependency_ref: ask.ref,
      // Copy into a plain mutable array — the carrier crosses the engine seam
      // and rides on `RecipeError.details`, so it must be a self-contained value.
      options: ask.options.map((o) => ({ entity_pk: o.entity_pk, label: o.label })),
      can_create: ask.can_create,
      ...(ask.create_op !== undefined ? { create_op: ask.create_op } : {}),
      ...(ask.target_write_op !== undefined ? { target_write_op: ask.target_write_op } : {}),
    };
  }
}

/** D-192 Slice 6c — thrown when a create's named container dependency (an Asana
 *  `project`) doesn't exist yet AND its `create_op` is granted: the create-assist
 *  DECIDED to create it but has not. The write can't dispatch until the container
 *  exists. Like `WorkEntityContainerPickRequiredError`, it carries a `create_plan`
 *  CARRIER the engine step-runner preserves onto `RecipeError.details.create_plan`;
 *  `handleExecute` reads it, raises ONE create-plan confirm enumerating the
 *  container create(s) + the pending write, and surfaces a terminal
 *  `create_plan_required`. On approval the container is created + the write re-runs;
 *  on deny nothing is created (no orphan). */
export class WorkEntityCreatePlanRequiredError extends Error {
  readonly code = 'WORK_ENTITY_CREATE_PLAN_REQUIRED';
  readonly source_id: string;
  readonly kind: WorkEntityKind;
  readonly create_plan: CreatePlanDetail;
  constructor(
    source_id: string,
    kind: WorkEntityKind,
    plans: readonly PlannedDependencyCreate[],
    target_summary: string,
  ) {
    super(
      `Creating a '${kind}' on Source '${source_id}' needs a new `
        + `${plans.map((p) => `${p.ref} '${p.name}'`).join(' + ')} created first. `
        + 'Confirm the create-plan request that was raised, then it will finish.',
    );
    this.name = 'WorkEntityCreatePlanRequiredError';
    this.source_id = source_id;
    this.kind = kind;
    // Copy into plain self-contained values — the carrier crosses the engine seam
    // on `RecipeError.details`, and each plan's `args` is already plain JSON.
    this.create_plan = {
      source_id,
      kind,
      plans: plans.map((p) => ({
        ref: p.ref,
        create_op: p.create_op,
        name: p.name,
        args: p.args,
        result_path: p.result_path,
        id_field: p.id_field,
      })),
      target_summary,
    };
  }
}

/** Thrown when the vendor half of a write failed AFTER the local write
 *  landed (update-family dispatchers are local-first). The local edit
 *  is saved and staged as a `pending_write` dirty marker — re-running
 *  the same write re-dispatches it. */
export class WorkEntityVendorWriteError extends Error {
  readonly code = 'WORK_ENTITY_VENDOR_WRITE_FAILED';
  readonly source_id: string;
  readonly kind: WorkEntityKind;
  readonly failure: 'config' | 'policy' | 'error';
  constructor(
    source_id: string,
    kind: WorkEntityKind,
    failure: 'config' | 'policy' | 'error',
    reason: string,
    staged: boolean,
  ) {
    super(
      `vendor write on Source '${source_id}' (${kind}) failed [${failure}]: ${reason}.`
        + (staged
          ? ' The local edit is saved and staged as a pending write — re-run the write to retry the vendor push.'
          : ''),
    );
    this.name = 'WorkEntityVendorWriteError';
    this.source_id = source_id;
    this.kind = kind;
    this.failure = failure;
  }
}

/** D-192 — thrown when the post-write ASSERT fails: the vendor call reported
 *  success, but reading the record back proves the vendor does NOT hold what we
 *  pushed (or, for a delete, that the record is still there).
 *
 *  Distinct from `WorkEntityWriteConflictError`, which is a CONCURRENT vendor
 *  edit detected BEFORE writing. This is OUR OWN write provably not landing, and
 *  it nearly always means the declaration is wrong — a mis-mapped `write_paths`
 *  entry or `op_bindings.*.id_arg` pointing at the wrong vendor field. It is a
 *  DECLARATION bug, not a transient, so retrying will not help; the message says
 *  so.
 *
 *  Before this existed, the post-write "verify" folded the vendor's (unchanged)
 *  value back over the user's edit, cleared the pending write, and reported
 *  `verified: true` — a corrupted vendor record, a silently reverted local edit,
 *  and a green result. */
export class WorkEntityWriteVerifyFailedError extends Error {
  readonly code = 'WORK_ENTITY_WRITE_VERIFY_FAILED';
  readonly source_id: string;
  readonly kind: WorkEntityKind;
  /** Canonical fields the patch pushed that the vendor did not end up holding.
   *  Empty for a delete (the whole record survived the delete). */
  readonly unlanded_fields: readonly string[];
  constructor(
    source_id: string,
    kind: WorkEntityKind,
    unlanded_fields: readonly string[],
    reason: string,
    staged: boolean,
  ) {
    super(
      `write verification failed on Source '${source_id}' (${kind}): ${reason}`
        + ' This is almost certainly a mis-declared Source (a write_paths entry or an'
        + ' op_bindings id_arg pointing at the wrong vendor field), not a transient —'
        + ' retrying will not help.'
        + (staged
          ? ' The local edit is kept as a pending write; the vendor state was NOT folded over it.'
          : ''),
    );
    this.name = 'WorkEntityWriteVerifyFailedError';
    this.source_id = source_id;
    this.kind = kind;
    this.unlanded_fields = unlanded_fields;
  }
}

/** Thrown when the vendor record changed the same field(s) since last
 *  sync and the declared conflict policy is `manual_merge` (spec
 *  § Conflict model). The local edit stays staged as the dirty side;
 *  resolve by re-reading the vendor state and re-writing with values
 *  that agree (the notification.ask / merge-card surface is the
 *  deferred follow-on). */
export class WorkEntityWriteConflictError extends Error {
  readonly code = 'WORK_ENTITY_WRITE_CONFLICT';
  readonly source_id: string;
  readonly kind: WorkEntityKind;
  readonly conflicting_fields: readonly string[];
  constructor(
    source_id: string,
    kind: WorkEntityKind,
    conflicting_fields: readonly string[],
    reason: string,
  ) {
    super(
      `write conflict on Source '${source_id}' (${kind}): ${reason}.`
        + ' The local edit is saved and staged as a pending write; the vendor record moved since'
        + ' last sync. Read the current vendor state and re-apply the intended values.',
    );
    this.name = 'WorkEntityWriteConflictError';
    this.source_id = source_id;
    this.kind = kind;
    this.conflicting_fields = conflicting_fields;
  }
}

/** Thrown when a commitment lifecycle transition is rejected. */
export class CommitmentLifecycleError extends Error {
  readonly code = 'COMMITMENT_LIFECYCLE_FORBIDDEN';
  readonly commitment_id: string;
  readonly from: string;
  readonly to: string;
  constructor(commitment_id: string, from: string, to: string, detail: string) {
    super(`commitment '${commitment_id}' lifecycle '${from}' → '${to}' rejected: ${detail}`);
    this.name = 'CommitmentLifecycleError';
    this.commitment_id = commitment_id;
    this.from = from;
    this.to = to;
  }
}

/** Thrown by the dispatcher when an update / delete / lifecycle
 *  ingredient targets an id that doesn't exist (or has been
 *  hard-deleted). */
export class WorkEntityNotFoundError extends Error {
  readonly code = 'WORK_ENTITY_NOT_FOUND';
  readonly kind: WorkEntityKind;
  readonly id: string;
  constructor(kind: WorkEntityKind, id: string) {
    super(`${kind} '${id}' not found`);
    this.name = 'WorkEntityNotFoundError';
    this.kind = kind;
    this.id = id;
  }
}

interface ReadThroughWriteTarget {
  source: SourceRegistration;
  source_record_id: string;
  qualified_id: string;
}

/** Recognise the one qualified-id shape that must bypass local-row lookup.
 * Wrong-kind and local-only spellings fail loudly before a provider call; a
 * mirrored Source returns null and continues through the established local-row
 * path. */
const resolveReadThroughWriteTarget = (
  deps: WorkEntityIngredientDeps,
  kind: WorkEntityKind,
  rawId: string,
): ReadThroughWriteTarget | null => {
  const qualified = parseQualifiedWorkEntityId(rawId);
  if (qualified === null) return null;
  if (qualified.kind !== kind) {
    throw new QualifiedWorkEntityIdError(
      'QUALIFIED_ID_KIND_MISMATCH',
      `QUALIFIED_ID_KIND_MISMATCH: this operation targets '${kind}', but the id is for `
        + `'${qualified.kind}'. No write was made. Retry with 'work.search' and use an id `
        + `whose kind is '${kind}'.`,
      { retry_with: 'work.search', actual_source: qualified.source_id },
    );
  }
  const source = deps.store.getSource(qualified.source_id);
  if (source === null || source.sync_posture !== 'read_through') return null;
  if (source.top_tier_kind !== kind) {
    throw new QualifiedWorkEntityIdError(
      'SOURCE_MISMATCH',
      `SOURCE_MISMATCH: the qualified id names source '${source.id}', but that Source `
        + `belongs to '${source.top_tier_kind}', not '${kind}'. No write was made. Retry `
        + `with 'work.search' and pass the returned id unchanged.`,
      {
        retry_with: 'work.search',
        expected_source: source.id,
        actual_source: qualified.source_id,
      },
    );
  }
  if (qualified.identity !== 'source') {
    throw new QualifiedWorkEntityIdError(
      'QUALIFIED_ID_LOCAL_ONLY',
      `QUALIFIED_ID_LOCAL_ONLY: source '${source.id}' is read_through and has no local row `
        + `id. No write was made. Retry with 'work.search' and pass its source-qualified `
        + 'id unchanged.',
      {
        retry_with: 'work.search',
        expected_source: source.id,
        actual_source: qualified.source_id,
      },
    );
  }
  return {
    source,
    source_record_id: qualified.record_id,
    qualified_id: rawId,
  };
};

/** Resolve an AI-facing qualified id back to the local mirror row used by
 * kernel CRUD. Legacy local ids remain valid for existing recipe/RPC callers. */
const resolveWorkEntityInputId = (
  deps: WorkEntityIngredientDeps,
  kind: WorkEntityKind,
  rawId: string,
): string => {
  const qualified = parseQualifiedWorkEntityId(rawId);
  if (qualified === null) return rawId;
  if (qualified.kind !== kind) {
    throw new QualifiedWorkEntityIdError(
      'QUALIFIED_ID_KIND_MISMATCH',
      `QUALIFIED_ID_KIND_MISMATCH: this operation targets '${kind}', but the id is for `
        + `'${qualified.kind}'. No write was made. Retry with 'work.search' and use an id `
        + `whose kind is '${kind}'.`,
      { retry_with: 'work.search', actual_source: qualified.source_id },
    );
  }
  const entity = qualified.identity === 'source'
    ? deps.store.readBySourceIdentity(kind, qualified.source_id, qualified.record_id)
    : deps.store.readByKind(kind, qualified.record_id);
  if (entity === null) throw new WorkEntityNotFoundError(kind, rawId);
  if (entity.source_id !== qualified.source_id) {
    throw new QualifiedWorkEntityIdError(
      'SOURCE_MISMATCH',
      `SOURCE_MISMATCH: the qualified id names source '${qualified.source_id}', but local row `
        + `'${entity.id}' belongs to '${entity.source_id}'. No write was made. Retry with `
        + `'work.search' and pass the returned id unchanged.`,
      {
        retry_with: 'work.search',
        expected_source: entity.source_id,
        actual_source: qualified.source_id,
      },
    );
  }
  return entity.id;
};

const readWorkEntityInput = (
  deps: WorkEntityIngredientDeps,
  kind: WorkEntityKind,
  rawId: string,
): WorkEntity | null => {
  const qualified = parseQualifiedWorkEntityId(rawId);
  if (qualified === null) return deps.resolver.readEntity(kind, rawId);
  if (qualified.kind !== kind) {
    throw new QualifiedWorkEntityIdError(
      'QUALIFIED_ID_KIND_MISMATCH',
      `QUALIFIED_ID_KIND_MISMATCH: work.read requested '${kind}', but the id is for `
        + `'${qualified.kind}'. Retry with kind '${qualified.kind}' and the same id.`,
      { retry_with: 'work.read', actual_source: qualified.source_id },
    );
  }
  // A read_through Source materializes no local row, so every lookup below
  // would answer `null` — and `work-entity-get` would report `found: false`
  // for a record that exists and is readable. Refuse with the surface that
  // CAN fetch it instead of returning a wrong answer.
  const registration = deps.store.getSource(qualified.source_id);
  if (registration !== null && registration.sync_posture === 'read_through') {
    throw new QualifiedWorkEntityIdError(
      'QUALIFIED_ID_LOCAL_ONLY',
      `QUALIFIED_ID_LOCAL_ONLY: source '${qualified.source_id}' is read_through and keeps no `
        + 'local row, so this generic read cannot resolve it. Retry with '
        + "'work.read' (or the Source's own provider read operation), which fetches it live.",
      { retry_with: 'work.read', expected_source: qualified.source_id, actual_source: qualified.source_id },
    );
  }
  const entity = qualified.identity === 'source'
    ? deps.resolver.readEntityBySourceIdentity(
        kind,
        qualified.source_id,
        qualified.record_id,
      )
    : deps.resolver.readEntity(kind, qualified.record_id);
  if (entity !== null && entity.source_id !== qualified.source_id) {
    throw new QualifiedWorkEntityIdError(
      'SOURCE_MISMATCH',
      `SOURCE_MISMATCH: the qualified id names source '${qualified.source_id}', but local row `
        + `'${entity.id}' belongs to '${entity.source_id}'. Retry with 'work.search'.`,
      {
        retry_with: 'work.search',
        expected_source: entity.source_id,
        actual_source: qualified.source_id,
      },
    );
  }
  return entity;
};

export interface WorkEntityIngredientDeps {
  store: WorkEntityStore;
  resolver: WorkEntityResolver;
  /** The owner's zone, for judging a DATE-ONLY deadline by its day when an
   *  update moves it (`due-day.ts`). Absent ⇒ UTC. */
  timeZone?: () => string | undefined;
  /** D-192 P4b — the declaration-driven write executor, late-bound (it
   *  needs the gateway fetch deps, composed after the dispatchers).
   *  Absent / null → connection-Sources refuse writes with
   *  `SOURCE_NOT_WRITE_CAPABLE` (the pre-executor posture). */
  getWriteExecutor?: () => WorkEntitySourceWriteExecutor | null;
  /** D-145 PA4 — warehouse event bus. Optional — absent means writes
   *  are silent (db-less test harness, dispatcher unit tests that
   *  don't care about emission). When wired, every successful
   *  create/update/delete/lifecycle dispatcher fires events on
   *  `data.work.<kind>.item.<event_kind>` so D-115 declarative
   *  `event_triggers` + user-installed reactive recipes pick them
   *  up. */
  bus?: WarehouseEventBus;
  /** D-145 PA4 — D-136 enrichment cascade engine. Optional — absent
   *  means dispatchers don't fan cascade fires (PA9 producers + the
   *  cascade engine wire together later). When wired, every
   *  successful update / delete fires the matching cascade primitive
   *  against the work-entity scope. */
  cascade?: CascadeEngine;
  now?: () => number;
}

// ────────────────────────────────────────────────────────────────
// PA4 — Warehouse-bus emission helpers
// ────────────────────────────────────────────────────────────────

/** Emit one warehouse event for a work-entity write. The bus stays
 *  collection-agnostic; the work-entity-flavored payload (canonical
 *  record + Source identity context) rides on the open `prev` slot per
 *  the per-collection convention. PA4 always populates the canonical
 *  record under `prev.record`; for `'updated'` / `'deleted'` events
 *  the prior record (when available) rides under `prev.prior`.
 *
 *  No-op when `deps.bus` is undefined. Errors are swallowed because
 *  the bus contract is fire-and-forget — a downstream listener crash
 *  must not roll back the dispatcher write. */
const emitWorkEntityEvent = (
  deps: WorkEntityIngredientDeps,
  kind: WorkEntityKind,
  event_kind: WarehouseEventKind,
  record: WorkEntity,
  prior?: WorkEntity,
): void => {
  if (!deps.bus) return;
  const at = deps.now?.() ?? Date.now();
  try {
    deps.bus.emit({
      platform: WORK_ENTITY_BUS_PLATFORM,
      slug: kind,
      entity_type: WORK_ENTITY_BUS_ENTITY_TYPE,
      event_kind,
      record_id: record.id,
      at,
      prev: {
        // The canonical record always rides for downstream consumers
        // that don't want to re-resolve `data.<kind>.<id>` (the recipe
        // can read `{{context.event.payload.prev.record.title}}`).
        record,
        source_id: record.source_id,
        // Prior record snapshot for diff-aware recipes (only present
        // for updated / deleted / completed / state_changed / etc.).
        ...(prior ? { prior } : {}),
      },
    });
  } catch {
    // Bus emission must not fail the write. The bus implementation
    // already swallows listener errors; this guards against an
    // emit-side throw.
  }
};

/** Tag the canonical record with its `_kind` discriminator before
 *  passing through the emit + cascade path. The store returns bare
 *  `Task` / `Note` / `Commitment` / `Project` shapes — the discriminator
 *  rides only at the bus boundary so listeners can branch without
 *  re-deriving from the path. */
/** The untagged record half of `WorkEntity`, DERIVED rather than
 *  re-spelled — `Task | Note | Commitment | Project` was a copy that a
 *  fifth kind silently fell out of. Distributive by construction (the
 *  naked type parameter distributes over the union), so it tracks
 *  `WorkEntity` automatically. */
type WorkEntityRecord<T = WorkEntity> = T extends { _kind: WorkEntityKind }
  ? Omit<T, '_kind'>
  : never;

const tagWorkEntity = <K extends WorkEntityKind>(
  kind: K,
  record: WorkEntityRecord,
): WorkEntity =>
  ({ _kind: kind, ...record }) as WorkEntity;

/** Fire the matching cascade primitive when the cascade engine is
 *  wired. Updates use `cascadeForSourceUpdate(scope, id)`; deletes use
 *  `cascadeForSourceDelete(scope, id)`. Creates do NOT fan cascade —
 *  the new row has no downstream enrichment rows to invalidate yet
 *  (PA9 producers fold new records on their own reactive cycles or
 *  housekeeping cadence). */
const cascadeOnWrite = (
  deps: WorkEntityIngredientDeps,
  kind: WorkEntityKind,
  id: string,
  op: 'update' | 'delete',
): void => {
  if (!deps.cascade) return;
  try {
    if (op === 'update') {
      deps.cascade.cascadeForSourceUpdate(kind, id);
    } else {
      deps.cascade.cascadeForSourceDelete(kind, id);
    }
  } catch {
    // Cascade failure is non-fatal for the dispatcher path. The
    // cascade engine logs internally; the user's write succeeded.
  }
};

/** The create-ish call's origin, forwarded from the run's
 *  `StepMeta` by the kernel adapter (D-161 plumbing — the same fields
 *  `contact-upsert` forwards). Absent on paths with no engine context
 *  (paired-UI CRUD rpc, dbless tests) — absent = human-origin,
 *  sticky-default preserved. */
export interface WorkEntityCreateOrigin {
  origin_actor?: import('@recued/contracts').Actor;
  origin_trigger_source?: string;
  /** D-192 baseline-admission (S2) — the run's FULL execution source, forwarded from
   *  `StepMeta` through the adapter's `withCreateOrigin` (which strips any
   *  recipe-supplied value → unforgeable). Threaded into the write executor's
   *  `prepare` so a vendor CREATE can compute the actor-aware CONTRACT-GRANT admission
   *  (`admitVendorWrite`): the OWNER / a granting DOOR is admitted past the vendor op's
   *  `'ask'` gate. Absent → no S2 admission (the create degrades on `ask` as before). */
  origin_execution_source?: import('@recued/contracts').ExecutionSource;
  /** D-192 6c.2c — engine-set flag (create-plan / container-pick re-run):
   *  this create's vendor write was pre-approved by the user's confirm, so the
   *  write executor admits it past the vendor op's `'ask'` gate (the standalone
   *  gated spine has no pause path — it would otherwise degrade to a policy
   *  fail, orphaning the just-created container). Forwarded from `StepMeta`
   *  through the adapter's `withCreateOrigin` (which strips recipe-supplied
   *  values), so it is unforgeable by a recipe / chat / MCP caller. */
  work_entity_write_preadmitted?: boolean;
}

/* ⛔ `isLlmOriginCreate` is DELETED (D-187 Sources half). It existed to keep an
 *  AI create from inheriting a sticky per-kind default a HUMAN pinned. With the
 *  default itself gone, every caller resolves `explicit source_id ?? built-in
 *  local` — so the distinction it drew no longer has two outcomes to choose
 *  between, and the safe branch is now the only branch. */

/** Resolve the Source for a create-ish call: **explicit `source_id` → Recued
 *  built-in local**. That is the whole rule.
 *
 *  ⛔ The sticky per-kind default that sat in the middle is GONE (D-187 Sources
 *  half). It was only ever consulted for a NON-LLM caller that omitted
 *  `source_id`, because the LLM path already skipped it deliberately — spec
 *  § Write policy: "source is a property of the decisively-resolved row, never
 *  an AI guess", the failure mode of default-local being "benign reconcilable
 *  divergence, never a wrong-vendor mutation". Removing it makes every caller
 *  behave the way the AI path already did on purpose. WRITE IS ALWAYS
 *  SOURCE-AWARE BY ID; nothing infers a destination. */
const resolveCreateSource = (
  deps: WorkEntityIngredientDeps,
  kind: WorkEntityKind,
  explicit_source_id: string | null | undefined,
  origin?: WorkEntityCreateOrigin,
): SourceRegistration => {
  // Codex P2 fold — an explicit EMPTY STRING is a caller error (a recipe
  // interpolating an unset variable into `source_id`), not a "use default"
  // hint: reject it upfront so the bug surfaces at dispatch rather than
  // silently writing to the per-kind default. But `null` is ABSENT, not a
  // bad value — the value-system's manifest sentinel (`input: { source_id:
  // null }`) rides the manifest→step merge as a literal `null` for any key
  // the caller omits (e.g. an op-step forwarding `{{context.event.payload}}`
  // that carries no source_id — the D-192 commitment-propose funnel), and
  // every other optional field here treats `!= null` as absent (see the
  // `!= null` note below). So `null` (like `undefined`) falls through to the
  // default-source resolution; only a supplied non-string / empty-string
  // throws. Without this, the kernel `commitment-create`/`commitment-propose`
  // op-step never mints (the sentinel `null` tripped the strict check).
  if (explicit_source_id != null && (typeof explicit_source_id !== 'string' || explicit_source_id.length === 0)) {
    throw new WorkEntityValidationError(
      'source_id must be a non-empty string when supplied',
      'source_id',
    );
  }
  const id =
    (typeof explicit_source_id === 'string' && explicit_source_id.length > 0
      ? explicit_source_id
      : null)
    ?? RECUED_BUILTIN_SOURCE_ID(kind);
  const reg = deps.store.getSource(id);
  if (reg === null) {
    // Surface as a validation error rather than a generic "source missing"
    // — the recipe layer typically fixes by pinning a different default
    // through Settings, and the typed error guides the surface.
    throw new WorkEntityValidationError(
      `source_id '${id}' is not registered in source_registry`,
      'source_id',
    );
  }
  if (reg.top_tier_kind !== kind) {
    throw new WorkEntityValidationError(
      `source_id '${id}' is registered for top_tier_kind '${reg.top_tier_kind}', not '${kind}'`,
      'source_id',
    );
  }
  return reg;
};

/** Pull the connection name out of a Source id. PA2's
 *  `CONNECTION_SOURCE_ID(vendor, name, kind)` returns
 *  `<vendor>.<name>.<kind>` so the middle segment is the connection
 *  name. Returns null when the Source isn't connection-shaped (Recued
 *  built-in lives at `recued.<kind>` — only two segments). */
const parseConnectionSourceId = (
  source_id: string,
): { vendor: string; connection_name: string; kind: string } | null => {
  const parts = source_id.split('.');
  if (parts.length < 3) return null;
  // Last segment is the kind; first is the vendor; everything in
  // between is the connection name (which itself can contain dots —
  // user can name a connection `acme.prod` if they like).
  return {
    vendor: parts[0]!,
    connection_name: parts.slice(1, -1).join('.'),
    kind: parts[parts.length - 1]!,
  };
};

/** The prepared vendor-write route a dispatcher threads from
 *  `prepareVendorWrite` (before its local write) into
 *  `dispatchVendorWrite` (after). Null = local-only (Recued built-in /
 *  future non-connection Sources, or a patch touching no declared
 *  writable vendor field). */
interface VendorWriteRoute {
  executor: WorkEntitySourceWriteExecutor;
  prepared: WorkEntityVendorWritePrepared;
}

const markSourceWriteCapable = (
  deps: WorkEntityIngredientDeps,
  source: SourceRegistration,
): void => {
  if (source.write_capable) return;
  deps.store.registerSource({
    id: source.id,
    top_tier_kind: source.top_tier_kind,
    source_kind: source.source_kind,
    sync_posture: source.sync_posture,
    source_label: source.source_label,
    write_capable: true,
    ...(source.schema_extension_blob ? { schema_extension_blob: source.schema_extension_blob } : {}),
    ...(source.config_blob ? { config_blob: source.config_blob } : {}),
  });
};

/** D-192 P4b phase 1 — resolve whether (and how) this write reaches a
 *  vendor. Runs BEFORE the dispatcher's local write:
 *    - non-connection Source: require `write_capable: true` (the boot
 *      wire registers builtins so), write locally only;
 *    - connection Source: the declaration-driven executor's `prepare`
 *      — a config refusal (no executor wired, no declaration,
 *      read_only, missing op/binding) throws `SOURCE_NOT_WRITE_CAPABLE`
 *      here so a structurally-unpushable write never leaves a silent
 *      local edit;
 *    - connection Source whose patch touches no declared writable
 *      field: local-only (null) — the divergence is the documented
 *      mirrored-row posture, and no pending state is staged.
 *
 *  Codex P1 fold (carried): connection Sources dispatch through the
 *  executor on EVERY write so the resulting row always ties back to a
 *  vendor-native `source_record_id` — the PA2 "first-dispatch
 *  capability probe" is the first success flipping
 *  `write_capable: false → true`, a side effect, not a one-off. */
const prepareVendorWrite = async (
  deps: WorkEntityIngredientDeps,
  source: SourceRegistration,
  kind: WorkEntityKind,
  operation: WorkEntityVendorWriteOperation,
  patch: Record<string, unknown>,
  opts: {
    /** D-192 Slice 6c.2c — per-dependency-ref caller-named containers ("create the
     *  task in project Roadmap" → `{ project: 'Roadmap' }`). Threaded verbatim into
     *  the create-assist resolver's `named` map, where a label-EXACT match picks the
     *  existing container and a granted no-match plans its create (the create-plan
     *  confirm). Absent → pick-only zero-config (lone auto-pick / ambiguous ask). */
    named?: Record<string, string>;
    /** D-192 Slice 6c.2c — the create-plan / container-pick re-run admission: this
     *  create's vendor write was pre-approved by the user's confirm, so stamp the
     *  prepared route to admit past the vendor op's `'ask'` gate. Create-only. */
    preadmitted?: boolean;
    /** D-192 baseline-admission (S2) — the run's execution source (forwarded by
     *  `withCreateOrigin` from `StepMeta`, unforgeable). Threaded to `executor.prepare`
     *  so a vendor CREATE admits past the `'ask'` gate when the OWNER / a granting DOOR
     *  governs the run (`admitVendorWrite`). Create-only; absent → no S2 admission. */
    execution_source?: ExecutionSource;
  } = {},
): Promise<VendorWriteRoute | null> => {
  const parsed = parseConnectionSourceId(source.id);
  if (!parsed) {
    if (!source.write_capable) {
      throw new WorkEntityWriteCapabilityError(source.id, kind);
    }
    return null;
  }
  const executor = deps.getWriteExecutor?.() ?? null;
  if (executor === null) {
    throw new WorkEntityWriteCapabilityError(source.id, kind, 'No write executor is wired');
  }
  // D-192 Slice 6a — create-assist preflight: resolve the source's prompt
  // container dependencies (Linear `team`) and thread the args they bind into the
  // create call. PICK-ONLY: auto-resolves a singleton / stored default; an
  // ambiguous container throws so the caller can present the choice set. Absent /
  // no-dependency sources resolve to empty args (byte-identical to pre-Slice-6a).
  // Slice 6c.2c: a caller-named container (`opts.named`) either label-matches an
  // existing option (pick) or — when its create_op is granted — plans a create.
  let dependencyCreateArgs: Record<string, unknown> | undefined;
  if (operation === 'create') {
    const dep = await executor.resolveCreateDependencies({
      source_id: source.id,
      kind,
      ...(opts.named !== undefined ? { named: opts.named } : {}),
    });
    if (!dep.ok) {
      if (dep.kind === 'ask') {
        throw new WorkEntityContainerPickRequiredError(source.id, kind, dep.ask);
      }
      throw new WorkEntityWriteCapabilityError(source.id, kind, dep.reason);
    }
    if (dep.plannedCreates.length > 0) {
      // D-192 baseline-admission (S3) — FAST-TRACK: before raising the 6c.2b owner
      // CONFIRM, offer the plan to the actor-aware contract-grant admission. If the
      // run's OWNER / granting DOOR contract grants EVERY op in the plan (each
      // container `create_op` + the target write), the grant IS the standing approval:
      // the container creates run inline (admitted) and the write proceeds with the
      // re-resolved args — no owner confirm (a contracted grant-holder must not stall
      // on a human). Any ungranted op / no execution source ⇒ the CONFIRM stands.
      const fast = await executor.tryFastTrackCreatePlan({
        source_id: source.id,
        kind,
        plannedCreates: dep.plannedCreates,
        ...(opts.execution_source !== undefined ? { execution_source: opts.execution_source } : {}),
        ...(opts.named !== undefined ? { named: opts.named } : {}),
      });
      if (fast.ok) {
        if (Object.keys(fast.createArgs).length > 0) dependencyCreateArgs = fast.createArgs;
      } else if (fast.kind === 'error') {
        // A container create failed mid-plan (not an authz miss) — surface it. The
        // already-created containers persist + are idempotent-reused on a re-issue.
        throw new WorkEntityWriteCapabilityError(source.id, kind, fast.reason);
      } else {
        // D-192 Slice 6c: not fast-trackable (no source / an ungranted plan op) — a named
        // container that doesn't exist yet was DECIDED but not executed. Surface the plan
        // so `handleExecute` raises ONE create-plan CONFIRM; the approved re-run creates
        // the container(s) then re-does the write. Nothing executes until approval (no
        // orphan on deny).
        const title = patch.title;
        const targetSummary =
          typeof title === 'string' && title.trim().length > 0
            ? `${kind} '${title.trim()}'`
            : `a ${kind}`;
        throw new WorkEntityCreatePlanRequiredError(source.id, kind, dep.plannedCreates, targetSummary);
      }
    } else if (Object.keys(dep.createArgs).length > 0) {
      dependencyCreateArgs = dep.createArgs;
    }
  }
  // Container-dependency resolution above is posture-independent — a
  // read-through Source picks its Asana workspace exactly like a mirrored one.
  // Only the LANDING differs, so only the prepare call forks here.
  const readThroughPosture = source.sync_posture === 'read_through';
  if (readThroughPosture && executor.prepareReadThrough === undefined) {
    throw new WorkEntityWriteCapabilityError(
      source.id,
      kind,
      'the wired write executor has no read-through path',
    );
  }
  const prepareInput = {
    source_id: source.id, kind, operation, patch,
    ...(dependencyCreateArgs !== undefined ? { dependencyCreateArgs } : {}),
    // Create-only admission — a re-run write pre-approved by the create-plan /
    // container-pick confirm; `prepare` stamps it onto the prepared route and
    // `dispatchCreate` converts it to the vendor invoke's `preflight_admitted`.
    ...(operation === 'create' && opts.preadmitted === true ? { preadmitted: true } : {}),
    // D-192 baseline-admission (S2) — the run's execution source so `prepare` can compute
    // the actor-aware contract-grant admission for a vendor create (the OWNER / a granting
    // DOOR admits past the `'ask'` gate). Unforgeable — forwarded from `StepMeta`.
    ...(opts.execution_source !== undefined ? { execution_source: opts.execution_source } : {}),
  };
  const prep = readThroughPosture
    ? executor.prepareReadThrough!(prepareInput)
    : executor.prepare(prepareInput);
  if (!prep.ok) {
    throw new WorkEntityWriteCapabilityError(source.id, kind, prep.reason);
  }
  if (!prep.vendor_relevant) return null;
  return { executor, prepared: prep.prepared };
};

/** D-192 P4b phase 2 — run the prepared vendor round-trip and map its
 *  outcome to the dispatcher's typed errors. `target` is absent for
 *  create (no local row yet). On the first success against a
 *  `write_capable: false` Source, flip the flag via the registerSource
 *  UPSERT (registered_at preserved). */
const dispatchVendorWrite = async (
  deps: WorkEntityIngredientDeps,
  source: SourceRegistration,
  kind: WorkEntityKind,
  route: VendorWriteRoute,
  target?: { local_id: string; prior: Task | Project | Note; current: Task | Project | Note },
): Promise<WorkEntityVendorWriteDispatchOutcome> => {
  const outcome = await route.executor.dispatch(route.prepared, target);
  if (!outcome.ok) {
    if (outcome.kind === 'conflict') {
      throw new WorkEntityWriteConflictError(
        source.id, kind, outcome.conflicting_fields, outcome.reason,
      );
    }
    // D-192 — the post-write assert refuted the write (or the delete). Throwing
    // is what keeps the caller's LOCAL write from standing on a vendor push that
    // never landed: `taskDelete` etc. run the vendor round-trip BEFORE the local
    // delete, so this throw is what stops us from tombstoning a record that is
    // still alive at the vendor (which the next sync would resurrect).
    if (outcome.kind === 'verify_failed') {
      throw new WorkEntityWriteVerifyFailedError(
        source.id, kind, outcome.unlanded_fields, outcome.reason, outcome.staged,
      );
    }
    throw new WorkEntityVendorWriteError(
      source.id, kind, outcome.kind, outcome.reason, outcome.staged,
    );
  }
  markSourceWriteCapable(deps, source);
  return outcome;
};

const previewField = (
  projected: ProjectedWorkEntityUpsert,
  field: string,
): string | undefined => {
  const blob = projected.write.source_extension_blob;
  if (blob === undefined || blob === null || typeof blob !== 'object' || Array.isArray(blob)) {
    return undefined;
  }
  const preview = blob.preview;
  if (preview === undefined || preview === null || typeof preview !== 'object' || Array.isArray(preview)) {
    return undefined;
  }
  const value = (preview as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
};

/** Shape a verified live response for the existing write contracts. The id is
 * intentionally the same Source-qualified id the caller supplied. This object
 * is returned only; it is never handed to WorkEntityStore. */
const projectReadThroughWriteEntity = (
  projected: ProjectedWorkEntityUpsert,
  qualifiedId: string,
  now: number,
): Task | Note | Project => {
  const write = projected.write;
  const updatedAt = write.source_updated_at ?? now;
  const identity = {
    id: qualifiedId,
    source_id: write.source_id,
    source_record_id: write.source_record_id,
    connection_id: write.connection_id,
    source_updated_at: write.source_updated_at,
    source_record_hash: write.source_record_hash,
    source_version_token: write.source_version_token,
    source_extension_blob: write.source_extension_blob,
    last_seen_at: now,
    sync_state: 'live' as const,
    conflict_policy: 'manual_merge' as const,
    created_at: updatedAt,
    updated_at: updatedAt,
  };
  switch (projected.kind) {
    case 'task': {
      const task = projected.write;
      const body = previewField(projected, 'body');
      return {
        ...identity,
        title: task.title,
        done: task.done ?? false,
        blocks_task_ids: [],
        ...(body !== undefined ? { body } : {}),
        ...(task.state !== undefined ? { state: task.state } : {}),
        ...(task.progress !== undefined ? { progress: task.progress } : {}),
        ...(task.due_at !== undefined ? { due_at: task.due_at } : {}),
        ...(task.priority !== undefined ? { priority: task.priority } : {}),
        ...(task.completed_at !== undefined ? { completed_at: task.completed_at } : {}),
      };
    }
    case 'note': {
      const note = projected.write;
      return {
        ...identity,
        body: previewField(projected, 'body') ?? '',
        last_user_action_at: now,
        related_contact_ids: [],
        related_calendar_event_ids: [],
        related_mail_thread_ids: [],
        related_project_ids: [],
        ...(note.title !== undefined ? { title: note.title } : {}),
      };
    }
    case 'project': {
      const project = projected.write;
      const description = previewField(projected, 'description');
      return {
        ...identity,
        title: project.title,
        state: project.state ?? 'active',
        last_activity_at: updatedAt,
        related_contact_ids: [],
        ...(description !== undefined ? { description } : {}),
        ...(project.target_completion_at !== undefined
          ? { target_completion_at: project.target_completion_at }
          : {}),
      };
    }
  }
};

const throwReadThroughDispatchFailure = (
  source: SourceRegistration,
  kind: WorkEntityKind,
  outcome: Extract<WorkEntityReadThroughWriteDispatchOutcome, { ok: false }>,
): never => {
  if (outcome.kind === 'verify_failed') {
    throw new WorkEntityWriteVerifyFailedError(
      source.id,
      kind,
      outcome.unlanded_fields,
      outcome.reason,
      false,
    );
  }
  throw new WorkEntityVendorWriteError(
    source.id,
    kind,
    outcome.kind,
    outcome.reason,
    false,
  );
};

/** Generic data.<kind> qualified-id route for non-materialising Sources. */
const dispatchReadThroughVendorWrite = async (
  deps: WorkEntityIngredientDeps,
  target: ReadThroughWriteTarget,
  kind: WorkEntityKind,
  operation: Exclude<WorkEntityVendorWriteOperation, 'create'>,
  patch: Record<string, unknown>,
): Promise<ProjectedWorkEntityUpsert | null> => {
  const executor = deps.getWriteExecutor?.() ?? null;
  if (executor === null) {
    throw new WorkEntityWriteCapabilityError(
      target.source.id,
      kind,
      'No write executor is wired',
    );
  }
  if (executor.prepareReadThrough === undefined || executor.dispatchReadThrough === undefined) {
    throw new WorkEntityWriteCapabilityError(
      target.source.id,
      kind,
      'The write executor does not support read-through routing',
    );
  }
  const prepared = executor.prepareReadThrough({
    source_id: target.source.id,
    kind,
    operation,
    patch,
  });
  if (!prepared.ok) {
    throw new WorkEntityWriteCapabilityError(target.source.id, kind, prepared.reason);
  }
  if (!prepared.vendor_relevant) {
    throw new WorkEntityWriteCapabilityError(
      target.source.id,
      kind,
      `${prepared.reason}; a read-through Source has no local-only write lane`,
    );
  }
  const pushed = new Set(prepared.prepared.pushable.map((field) => field.field));
  const localOnly = Object.entries(patch)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([field]) => field)
    .filter((field) => !pushed.has(field));
  if (localOnly.length > 0) {
    throw new WorkEntityWriteCapabilityError(
      target.source.id,
      kind,
      `Read-through has no local row for unrouteable field(s): ${localOnly.join(', ')}`,
    );
  }
  const outcome = await executor.dispatchReadThrough(
    prepared.prepared,
    target.source_record_id,
  );
  if (!outcome.ok) {
    return throwReadThroughDispatchFailure(target.source, kind, outcome);
  }
  markSourceWriteCapable(deps, target.source);
  return outcome.operation === 'delete' ? null : outcome.projected;
};

/** Read-through CREATE — the one read-through write with no incoming qualified
 *  id, because the id does not exist until the vendor mints it. The vendor's
 *  native id becomes the `we1` identity the caller answers with, so the very
 *  next `data.<kind>.update` routes straight back to the same remote record.
 *
 *  No local row is written and no warehouse event fires — the same posture the
 *  read-through update path holds. A reactive recipe that must see these
 *  creates watches the Source, not `data.work.<kind>.item.created`. */
const dispatchReadThroughCreateWrite = async (
  deps: WorkEntityIngredientDeps,
  source: SourceRegistration,
  kind: WorkEntityKind,
  route: VendorWriteRoute,
): Promise<{ projected: ProjectedWorkEntityUpsert; qualified_id: string }> => {
  if (route.executor.dispatchReadThroughCreate === undefined) {
    throw new WorkEntityWriteCapabilityError(
      source.id,
      kind,
      'The write executor does not support read-through create routing',
    );
  }
  const outcome = await route.executor.dispatchReadThroughCreate(route.prepared);
  if (!outcome.ok) return throwReadThroughDispatchFailure(source, kind, outcome);
  if (outcome.operation !== 'create') {
    throw new WorkEntityVendorWriteError(
      source.id,
      kind,
      'error',
      `read-through create returned a '${outcome.operation}' outcome`,
      false,
    );
  }
  markSourceWriteCapable(deps, source);
  return {
    projected: outcome.projected,
    qualified_id: qualifyWorkEntityId({
      kind,
      source_id: source.id,
      source_record_id: outcome.source_record_id,
      // Never read — `local_id` is the fallback only when there is no source
      // record id, and a create that reached here always has one.
      local_id: outcome.source_record_id,
    }),
  };
};

/** Refuse a read-through create that was handed fields with nowhere to land.
 *  Relationship / FK / extension fields ride the LOCAL lane (they are excluded
 *  from the vendor patch by construction), and a read-through Source has no
 *  local row — so accepting them would drop the caller's data silently while
 *  reporting success. Mirrors the read-through update path's `localOnly` guard. */
const refuseUnroutableReadThroughCreateFields = (
  source: SourceRegistration,
  kind: WorkEntityKind,
  localOnlyInput: Record<string, unknown>,
): void => {
  const supplied = Object.entries(localOnlyInput)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([field]) => field);
  if (supplied.length === 0) return;
  throw new WorkEntityWriteCapabilityError(
    source.id,
    kind,
    `read-through create has no local row for ${supplied.join(', ')} — these fields never reach `
      + 'the provider. Create the record without them, or use a records-posture Source',
  );
};

/** Apply a create dispatch's vendor-truth stamp to the local write
 *  input. Applied as a WHOLE (token + coerced timestamp + hash +
 *  extension blob together) so the stored hash always covers the
 *  stored lanes — a hash without its blob would make the first sync
 *  cycle skip the row and the preview/extension lanes never land. */
const applyCreateStamp = (
  writeInput: { source_record_id?: string } & Partial<Record<
    'source_version_token' | 'source_record_hash', string
  >> & { source_updated_at?: number; source_extension_blob?: Record<string, unknown> },
  stamp: WorkEntityVendorWriteStamp | undefined,
): void => {
  if (stamp === undefined) return;
  if (stamp.source_version_token !== undefined) writeInput.source_version_token = stamp.source_version_token;
  if (stamp.source_updated_at !== undefined) writeInput.source_updated_at = stamp.source_updated_at;
  if (stamp.source_record_hash !== undefined) writeInput.source_record_hash = stamp.source_record_hash;
  if (stamp.source_extension_blob !== undefined) writeInput.source_extension_blob = stamp.source_extension_blob;
};

// ────────────────────────────────────────────────────────────────
// task-* dispatchers
// ────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────
// Idempotent creates — note / commitment / project
// ────────────────────────────────────────────────────────────────

/** Where an idempotent create stamps its key, per kind (a task's is
 *  `recued_task_idempotency_key`). */
const IDEMPOTENCY_MARK = {
  note: 'recued_note_idempotency_key',
  commitment: 'recued_commitment_idempotency_key',
  project: 'recued_project_idempotency_key',
} as const;

/** The check INSIDE the write, for a note / commitment / project create — the
 *  contract a task's already has (`taskCreate`): a valid key lands on one
 *  stable Recued-local id, and a repeat returns the record it made, whatever
 *  any earlier read saw — two runs racing get one record. A key cannot route to
 *  a vendor Source. Null when the caller sent no key. */
const idempotentCreateKey = (
  kind: keyof typeof IDEMPOTENCY_MARK,
  raw: unknown,
  sourceId: string | null | undefined,
): { key: string; id: string } | null => {
  if (raw == null) return null;
  const id = isTaskIdempotencyKey(raw) ? workEntityIdFromIdempotencyKey(kind, raw) : null;
  if (id === null) {
    throw new WorkEntityValidationError(
      'idempotency_key must be a non-empty namespaced ASCII key within the size cap',
      'idempotency_key',
    );
  }
  if (sourceId != null && sourceId !== RECUED_BUILTIN_SOURCE_ID(kind)) {
    throw new WorkEntityValidationError(
      `idempotent ${kind} creation is Recued-local and cannot target a vendor Source`,
      'source_id',
    );
  }
  return { key: raw as string, id };
};

/** A repeat create found a row at the key's id: it is returned only when it is
 *  this key's live, Recued-local record. A deleted one is refused, not revived —
 *  an automation must not bring back what the owner removed — and an unrelated
 *  one is never adopted or overwritten. */
const verifyIdempotentReuse = (
  kind: keyof typeof IDEMPOTENCY_MARK,
  existing: {
    deleted_at?: number;
    sync_state: string;
    source_id: string;
    source_extension_blob?: Record<string, unknown>;
  },
  key: string,
): void => {
  if (existing.deleted_at !== undefined || existing.sync_state !== 'live') {
    throw new WorkEntityValidationError(
      `idempotency_key resolved to a non-live or tombstoned ${kind}`,
      'idempotency_key',
    );
  }
  if (
    existing.source_id !== RECUED_BUILTIN_SOURCE_ID(kind)
    || existing.source_extension_blob?.[IDEMPOTENCY_MARK[kind]] !== key
  ) {
    throw new WorkEntityValidationError(
      `idempotency_key resolved to an unrelated existing ${kind}`,
      'idempotency_key',
    );
  }
};

// ────────────────────────────────────────────────────────────────
// Date inputs — one conversion for every work-entity date a caller sends
// ────────────────────────────────────────────────────────────────

/** A date a caller sent for `field`, as the epoch ms the store keeps.
 *
 *  ⛔ THE STORE KEEPS NUMBERS ONLY. A date kept as text reads as `NaN` to every
 *  sweep — a commitment promised as text never came due, never reminded, never
 *  escalated. Text that names exactly one instant is converted here
 *  (`unambiguousDateMs`: epoch-ms digits, a real `YYYY-MM-DD` day as UTC
 *  midnight, an ISO date-time WITH its zone). A date-time with NO zone is
 *  refused, not guessed: it is a different instant in every zone and the server
 *  cannot know whose clock it was (the webclient sends the owner's offset with
 *  one). `null` stays the caller's — an update clears a date with it; a blank
 *  string is no value at all. */
const dateInputMs = (field: string, value: unknown): number | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw new WorkEntityValidationError(`${field} must be a finite number`, field);
  }
  if (typeof value !== 'string') {
    throw new WorkEntityValidationError(`${field} must be a date, got ${typeof value}`, field);
  }
  const text = value.trim();
  if (text === '') return undefined;
  const ms = unambiguousDateMs(text);
  if (ms !== null) return ms;
  if (ZONELESS_DATE_TIME.test(text)) {
    throw new WorkEntityValidationError(
      `${field} '${text}' has no time zone — send a date (YYYY-MM-DD), epoch ms, or a time with its offset`,
      field,
    );
  }
  throw new WorkEntityValidationError(`${field} '${text.slice(0, 40)}' is not a date`, field);
};

/** `input` with each named date converted by `dateInputMs`; the same object
 *  when nothing needed converting. */
const withDateInputs = <T extends object>(input: T, fields: readonly string[]): T => {
  let out: Record<string, unknown> | undefined;
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) continue;
    const raw = (input as Record<string, unknown>)[field];
    const ms = dateInputMs(field, raw);
    if (ms === raw) continue;
    out ??= { ...(input as Record<string, unknown>) };
    if (ms === undefined) delete out[field];
    else out[field] = ms;
  }
  return (out ?? input) as T;
};

const taskCreate = (deps: WorkEntityIngredientDeps) =>
  async (input: {
    title: string;
    idempotency_key?: string;
    body?: string;
    due_at?: number;
    priority?: import('@recued/contracts').TaskPriority;
    state?: string;
    progress?: number;
    done?: boolean;
    completed_at?: number;
    assigned_contact_id?: string;
    parent_calendar_event_id?: string;
    linked_mail_thread_id?: string;
    parent_project_id?: string;
    blocks_task_ids?: readonly string[];
    source_id?: string;
    source_extension_blob?: Record<string, unknown>;
    /** D-192 6c.2c — caller-named vendor containers by dependency ref
     *  (`{ project: 'Roadmap' }`); a granted no-match plans the container create. */
    container_names?: Record<string, string>;
  } & WorkEntityCreateOrigin): Promise<{ task: Task }> => {
    input = withDateInputs(input, ['due_at', 'completed_at']);
    const rawIdempotencyKey = input.idempotency_key as unknown;
    if (rawIdempotencyKey != null && !isTaskIdempotencyKey(rawIdempotencyKey)) {
      throw new WorkEntityValidationError(
        'idempotency_key must be a non-empty namespaced ASCII key within the size cap',
        'idempotency_key',
      );
    }
    const idempotencyKey = isTaskIdempotencyKey(rawIdempotencyKey)
      ? rawIdempotencyKey
      : null;
    const localTaskSource = RECUED_BUILTIN_SOURCE_ID('task');
    if (
      idempotencyKey !== null
      && input.source_id != null
      && input.source_id !== localTaskSource
    ) {
      throw new WorkEntityValidationError(
        'idempotent task creation is Recued-local and cannot target a vendor Source',
        'source_id',
      );
    }
    const source = resolveCreateSource(
      deps,
      'task',
      idempotencyKey === null ? input.source_id : localTaskSource,
      input,
    );
    // The vendor patch carries only the projection-lane candidates —
    // the executor intersects with the declared writable fields (FK /
    // relationship fields never push; origin fields steer Source
    // resolution only).
    const route = await prepareVendorWrite(deps, source, 'task', 'create', {
      title: input.title,
      body: input.body,
      due_at: input.due_at,
      priority: input.priority,
      state: input.state,
      progress: input.progress,
      done: input.done,
      completed_at: input.completed_at,
    }, {
      ...(input.container_names !== undefined ? { named: input.container_names } : {}),
      ...(input.work_entity_write_preadmitted === true ? { preadmitted: true } : {}),
      // D-192 baseline-admission (S2) — the run's execution source (unforgeable, set by
      // `withCreateOrigin` from StepMeta) so a vendor create admits past `'ask'` when the
      // OWNER / a granting DOOR governs the run.
      ...(input.origin_execution_source !== undefined
        ? { execution_source: input.origin_execution_source }
        : {}),
    });
    if (source.sync_posture === 'read_through') {
      refuseUnroutableReadThroughCreateFields(source, 'task', {
        assigned_contact_id: input.assigned_contact_id,
        parent_calendar_event_id: input.parent_calendar_event_id,
        linked_mail_thread_id: input.linked_mail_thread_id,
        parent_project_id: input.parent_project_id,
        blocks_task_ids: input.blocks_task_ids,
        source_extension_blob: input.source_extension_blob,
      });
      if (route === null) {
        throw new WorkEntityWriteCapabilityError(
          source.id,
          'task',
          'a read-through Source has no local-only create lane',
        );
      }
      const created = await dispatchReadThroughCreateWrite(deps, source, 'task', route);
      if (created.projected.kind !== 'task') {
        throw new WorkEntityVendorWriteError(
          source.id, 'task', 'error',
          'verified read-through create returned no task projection', false,
        );
      }
      return {
        task: projectReadThroughWriteEntity(
          created.projected,
          created.qualified_id,
          deps.now?.() ?? Date.now(),
        ) as Task,
      };
    }
    const vendor = route !== null
      ? await dispatchVendorWrite(deps, source, 'task', route)
      : null;
    const writeInput: TaskWriteInput = {
      source_id: source.id,
      title: input.title,
    };
    if (idempotencyKey !== null) {
      const deterministicId = taskIdFromIdempotencyKey(idempotencyKey);
      if (deterministicId === null) {
        throw new WorkEntityValidationError(
          'idempotency_key could not produce a stable task id',
          'idempotency_key',
        );
      }
      writeInput.id = deterministicId;
    }
    // `!= null` treats both `null` and `undefined` as "absent" — recipes
    // routinely surface `null` when an optional step is skipped (e.g.
    // `skip_when` collapsed a monetary-value or due-date branch). The
    // store layer's destructuring + regex checks assume the field is
    // either present-and-valid or absent; routing `null` through would
    // throw at commit time. Keep `false` / `0` / `""` valid values.
    if (input.body != null) writeInput.body = input.body;
    if (input.due_at != null) writeInput.due_at = input.due_at;
    if (input.priority != null) writeInput.priority = input.priority;
    if (input.state != null) writeInput.state = input.state;
    if (input.progress != null) writeInput.progress = input.progress;
    if (input.done != null) writeInput.done = input.done;
    if (input.completed_at != null) writeInput.completed_at = input.completed_at;
    if (input.assigned_contact_id != null) writeInput.assigned_contact_id = input.assigned_contact_id;
    if (input.parent_calendar_event_id != null) writeInput.parent_calendar_event_id = input.parent_calendar_event_id;
    if (input.linked_mail_thread_id != null && input.linked_mail_thread_id !== '') {
      writeInput.linked_mail_thread_id = input.linked_mail_thread_id;
    }
    if (input.parent_project_id != null) {
      writeInput.parent_project_id = resolveWorkEntityInputId(
        deps,
        'project',
        input.parent_project_id,
      );
    }
    if (input.blocks_task_ids != null) {
      writeInput.blocks_task_ids = input.blocks_task_ids.map((id) =>
        resolveWorkEntityInputId(deps, 'task', id));
    }
    if (input.source_extension_blob != null) writeInput.source_extension_blob = input.source_extension_blob;
    if (idempotencyKey !== null) {
      writeInput.source_extension_blob = {
        ...(writeInput.source_extension_blob ?? {}),
        recued_task_idempotency_key: idempotencyKey,
      };
    }
    if (vendor !== null && vendor.ok && vendor.operation === 'create') {
      writeInput.source_record_id = vendor.source_record_id;
      // The vendor-truth stamp (token/timestamp/hash/extension blob)
      // makes the row conflict-ready immediately. The vendor blob
      // REPLACES a recipe-supplied one — the blob is the mirror lane
      // on a connection-Source row.
      applyCreateStamp(writeInput, vendor.stamp);
    }
    if (idempotencyKey !== null) {
      const ensured = deps.store.ensureTask(
        writeInput as TaskWriteInput & { id: string },
        deps.now?.(),
      );
      if (!ensured.created) {
        if (
          ensured.task.deleted_at !== undefined
          || ensured.task.sync_state !== 'live'
        ) {
          throw new WorkEntityValidationError(
            'idempotency_key resolved to a non-live or tombstoned task',
            'idempotency_key',
          );
        }
        if (
          ensured.task.source_id !== localTaskSource
          || ensured.task.source_extension_blob?.recued_task_idempotency_key !== idempotencyKey
        ) {
          throw new WorkEntityValidationError(
            'idempotency_key resolved to an unrelated existing task',
            'idempotency_key',
          );
        }
        return { task: ensured.task };
      }
      emitWorkEntityEvent(deps, 'task', 'created', tagWorkEntity('task', ensured.task));
      return { task: ensured.task };
    }
    const task = deps.store.writeTask(writeInput, deps.now?.());
    emitWorkEntityEvent(deps, 'task', 'created', tagWorkEntity('task', task));
    return { task };
  };

const taskUpdate = (deps: WorkEntityIngredientDeps) =>
  async (input: {
    id: string;
    title?: string;
    body?: string;
    due_at?: number;
    priority?: import('@recued/contracts').TaskPriority;
    state?: string;
    progress?: number;
    assigned_contact_id?: string;
    parent_calendar_event_id?: string;
    linked_mail_thread_id?: string;
    parent_project_id?: string;
    blocks_task_ids?: readonly string[];
    source_extension_blob?: Record<string, unknown>;
    /** Remove the due date. `due_at: null` cannot say it — for a task, `null`
     *  means "not given" (see the patch-or-preserve note below). */
    clear_due_at?: boolean;
  }): Promise<{ task: Task }> => {
    input = withDateInputs(input, ['due_at', 'completed_at']);
    const clearDue = input.clear_due_at === true;
    if (clearDue && input.due_at != null) {
      throw new WorkEntityValidationError('send due_at or clear_due_at, not both', 'clear_due_at');
    }
    // ⛔ What a Source is told about the due date. `null` is a Source's "remove"
    // (`clear_args`), so a task's own `null` — "not given" — must never reach
    // one: a recipe's unset input would remove a partner's deadline.
    const dueForSource = clearDue ? null : (input.due_at ?? undefined);
    const readThrough = resolveReadThroughWriteTarget(deps, 'task', input.id);
    if (readThrough !== null) {
      const projected = await dispatchReadThroughVendorWrite(
        deps,
        readThrough,
        'task',
        'update',
        {
          title: input.title,
          body: input.body,
          due_at: dueForSource,
          priority: input.priority,
          state: input.state,
          progress: input.progress,
          assigned_contact_id: input.assigned_contact_id,
          parent_calendar_event_id: input.parent_calendar_event_id,
          linked_mail_thread_id: input.linked_mail_thread_id,
          parent_project_id: input.parent_project_id,
          blocks_task_ids: input.blocks_task_ids,
          source_extension_blob: input.source_extension_blob,
        },
      );
      if (projected === null || projected.kind !== 'task') {
        throw new WorkEntityVendorWriteError(
          readThrough.source.id,
          'task',
          'error',
          'verified read-through update returned no task projection',
          false,
        );
      }
      return {
        task: projectReadThroughWriteEntity(
          projected,
          readThrough.qualified_id,
          deps.now?.() ?? Date.now(),
        ) as Task,
      };
    }
    const localId = resolveWorkEntityInputId(deps, 'task', input.id);
    const existing = deps.store.readTask(localId);
    if (!existing) throw new WorkEntityNotFoundError('task', input.id);
    const sourceReg = deps.store.getSource(existing.source_id);
    // Phase 1 BEFORE the local write — a structurally-unpushable
    // Source refuses here (no silent local edit); a vendor-relevant
    // patch dispatches AFTER the local write + events (local-first).
    const route = sourceReg !== null
      ? await prepareVendorWrite(deps, sourceReg, 'task', 'update', {
          title: input.title,
          body: input.body,
          due_at: dueForSource,
          priority: input.priority,
          state: input.state,
          progress: input.progress,
        })
      : null;
    // Update inherits Source identity from the row. The store's
    // `writeTask` is upsert-by-id so we re-supply every required
    // Source-row-identity field plus the patched user fields.
    const writeInput: TaskWriteInput = {
      id: existing.id,
      title: input.title ?? existing.title,
      source_id: existing.source_id,
      created_at: existing.created_at,
      // updated_at re-stamps to now via the store default.
    };
    // Patch-or-preserve. `!= null` treats both `null` and `undefined` as
    // "absent" so the supplied field falls through to the existing value —
    // matching the create path's `!= null` guards + the `state`/`progress`
    // fork (a) below. Recipes routinely surface `null` for an unset optional
    // input (a `skip_when`-collapsed branch, or the engine filling an
    // ingredient's declared-but-unset input with its `null` manifest default);
    // routing that `null` through with `!== undefined` made an ad-hoc
    // `task-update` of one field either reject (`due_at must be a finite
    // number` / `unknown priority 'null'`) or silently CLEAR every other
    // field. `false` / `0` / `""` stay valid values.
    if (input.body != null) writeInput.body = input.body;
    else if (existing.body !== undefined) writeInput.body = existing.body;
    // A cleared due date is left out of the rewritten row, which removes it.
    if (!clearDue) {
      if (input.due_at != null) writeInput.due_at = input.due_at;
      else if (existing.due_at !== undefined) writeInput.due_at = existing.due_at;
    }
    if (input.priority != null) writeInput.priority = input.priority;
    else if (existing.priority !== undefined) writeInput.priority = existing.priority;
    // D-179 fork (a) — `state` / `progress` patch-or-preserve (the posture the
    // fields above are now aligned to).
    if (input.state != null) writeInput.state = input.state;
    else if (existing.state !== undefined) writeInput.state = existing.state;
    if (input.progress != null) writeInput.progress = input.progress;
    else if (existing.progress !== undefined) writeInput.progress = existing.progress;
    writeInput.done = existing.done;
    if (existing.completed_at !== undefined) writeInput.completed_at = existing.completed_at;
    if (input.assigned_contact_id != null) writeInput.assigned_contact_id = input.assigned_contact_id;
    else if (existing.assigned_contact_id !== undefined) writeInput.assigned_contact_id = existing.assigned_contact_id;
    if (input.parent_calendar_event_id != null) writeInput.parent_calendar_event_id = input.parent_calendar_event_id;
    else if (existing.parent_calendar_event_id !== undefined) writeInput.parent_calendar_event_id = existing.parent_calendar_event_id;
    if (input.linked_mail_thread_id != null) writeInput.linked_mail_thread_id = input.linked_mail_thread_id;
    else if (existing.linked_mail_thread_id !== undefined) writeInput.linked_mail_thread_id = existing.linked_mail_thread_id;
    if (input.parent_project_id != null) {
      writeInput.parent_project_id = resolveWorkEntityInputId(
        deps,
        'project',
        input.parent_project_id,
      );
    } else if (existing.parent_project_id !== undefined) {
      writeInput.parent_project_id = existing.parent_project_id;
    }
    writeInput.blocks_task_ids = input.blocks_task_ids?.map((id) =>
      resolveWorkEntityInputId(deps, 'task', id)
    ) ?? existing.blocks_task_ids;
    if (existing.source_record_id !== undefined) writeInput.source_record_id = existing.source_record_id;
    if (existing.connection_id !== undefined) writeInput.connection_id = existing.connection_id;
    if (existing.source_record_hash !== undefined) writeInput.source_record_hash = existing.source_record_hash;
    if (existing.source_version_token !== undefined) writeInput.source_version_token = existing.source_version_token;
    if (existing.source_updated_at !== undefined) writeInput.source_updated_at = existing.source_updated_at;
    const nextSourceExtensionBlob =
      input.source_extension_blob ?? existing.source_extension_blob;
    if (nextSourceExtensionBlob !== undefined) {
      writeInput.source_extension_blob = nextSourceExtensionBlob;
    }
    writeInput.sync_state = existing.sync_state;
    writeInput.conflict_policy = existing.conflict_policy;
    const task = deps.store.writeTask(writeInput, deps.now?.());
    emitWorkEntityEvent(
      deps,
      'task',
      'updated',
      tagWorkEntity('task', task),
      tagWorkEntity('task', existing),
    );
    // D-179 fork (a) — a genuine `state` transition ALSO fires
    // `state_changed`, mirroring commitment / project, so recipes can
    // subscribe to `data.work.task.item.state_changed` without
    // filtering every `updated`.
    if (task.state !== existing.state) {
      emitWorkEntityEvent(
        deps,
        'task',
        'state_changed',
        tagWorkEntity('task', task),
        tagWorkEntity('task', existing),
      );
    }
    cascadeOnWrite(deps, 'task', task.id, 'update');
    if (route !== null && sourceReg !== null) {
      // Vendor push: stage → read-before-write → narrow patch →
      // verify → mirror-refresh. A failure throws (typed) but the
      // local edit above stands, staged as an honest pending write.
      await dispatchVendorWrite(deps, sourceReg, 'task', route, {
        local_id: existing.id,
        prior: existing,
        current: task,
      });
      // The verify upsert refreshed the row with the vendor's
      // canonical result — return the fresh row, not the stale one.
      const refreshed = deps.store.readTask(existing.id);
      if (refreshed !== null) return { task: refreshed };
    }
    return { task };
  };

const taskDelete = (deps: WorkEntityIngredientDeps) =>
  async (input: { id: string; tombstone?: boolean }): Promise<{
    ok: true;
    id: string;
    tombstoned: boolean;
  }> => {
    const readThrough = resolveReadThroughWriteTarget(deps, 'task', input.id);
    if (readThrough !== null) {
      await dispatchReadThroughVendorWrite(deps, readThrough, 'task', 'delete', {});
      return { ok: true as const, id: input.id, tombstoned: false };
    }
    const localId = resolveWorkEntityInputId(deps, 'task', input.id);
    const existing = deps.store.readTask(localId);
    if (!existing) throw new WorkEntityNotFoundError('task', input.id);
    const tombstone = input.tombstone !== false;
    const sourceReg = deps.store.getSource(existing.source_id);
    // Delete stays VENDOR-FIRST: a local-first tombstone against a
    // live vendor record would be resurrected by the next sync cycle.
    if (sourceReg) {
      const route = await prepareVendorWrite(deps, sourceReg, 'task', 'delete', {});
      if (route !== null) {
        await dispatchVendorWrite(deps, sourceReg, 'task', route, {
          local_id: existing.id,
          prior: existing,
          current: existing,
        });
      }
    }
    const ok = deps.store.deleteTask(localId, { tombstone, ...(deps.now ? { now: deps.now() } : {}) });
    if (!ok) throw new WorkEntityNotFoundError('task', input.id);
    emitWorkEntityEvent(deps, 'task', 'deleted', tagWorkEntity('task', existing), tagWorkEntity('task', existing));
    cascadeOnWrite(deps, 'task', existing.id, 'delete');
    return { ok: true as const, id: input.id, tombstoned: tombstone };
  };

const taskMarkDone = (deps: WorkEntityIngredientDeps) =>
  async (input: { id: string; done?: boolean; completed_at?: number }): Promise<{ task: Task }> => {
    input = withDateInputs(input, ['completed_at']);
    const readThrough = resolveReadThroughWriteTarget(deps, 'task', input.id);
    if (readThrough !== null) {
      const done = input.done !== false;
      const projected = await dispatchReadThroughVendorWrite(
        deps,
        readThrough,
        'task',
        'complete',
        {
          done,
          completed_at: done ? input.completed_at ?? (deps.now?.() ?? Date.now()) : undefined,
        },
      );
      if (projected === null || projected.kind !== 'task') {
        throw new WorkEntityVendorWriteError(
          readThrough.source.id,
          'task',
          'error',
          'verified read-through completion returned no task projection',
          false,
        );
      }
      return {
        task: projectReadThroughWriteEntity(
          projected,
          readThrough.qualified_id,
          deps.now?.() ?? Date.now(),
        ) as Task,
      };
    }
    const localId = resolveWorkEntityInputId(deps, 'task', input.id);
    const existing = deps.store.readTask(localId);
    if (!existing) throw new WorkEntityNotFoundError('task', input.id);
    const done = input.done !== false;
    const sourceReg = deps.store.getSource(existing.source_id);
    // The `complete` op slot (executor falls back to the update op
    // when no dedicated complete op is declared). A declaration whose
    // writable fields don't cover `done`/`completed_at` (the kernel
    // hb/sf posture — vendor completion is a state enum the closed
    // derivation set doesn't invert yet) resolves vendor-irrelevant:
    // the completion lands locally only, until a vendor change
    // rewrites the row (the documented mirrored-row posture).
    const route = sourceReg !== null
      ? await prepareVendorWrite(deps, sourceReg, 'task', 'complete', {
          done,
          completed_at: input.completed_at,
        })
      : null;
    const now = deps.now?.() ?? Date.now();
    const writeInput: TaskWriteInput = {
      id: existing.id,
      title: existing.title,
      source_id: existing.source_id,
      created_at: existing.created_at,
      done,
      blocks_task_ids: existing.blocks_task_ids,
      sync_state: existing.sync_state,
      conflict_policy: existing.conflict_policy,
    };
    if (done) {
      writeInput.completed_at = input.completed_at ?? now;
    }
    if (existing.body !== undefined) writeInput.body = existing.body;
    if (existing.due_at !== undefined) writeInput.due_at = existing.due_at;
    if (existing.priority !== undefined) writeInput.priority = existing.priority;
    // D-179 fork (a) — preserve through the upsert (omitting them
    // would NULL the columns; codex HIGH fold).
    if (existing.state !== undefined) writeInput.state = existing.state;
    if (existing.progress !== undefined) writeInput.progress = existing.progress;
    if (existing.assigned_contact_id !== undefined) writeInput.assigned_contact_id = existing.assigned_contact_id;
    if (existing.parent_calendar_event_id !== undefined) writeInput.parent_calendar_event_id = existing.parent_calendar_event_id;
    if (existing.linked_mail_thread_id !== undefined) writeInput.linked_mail_thread_id = existing.linked_mail_thread_id;
    if (existing.parent_project_id !== undefined) writeInput.parent_project_id = existing.parent_project_id;
    if (existing.source_record_id !== undefined) writeInput.source_record_id = existing.source_record_id;
    if (existing.connection_id !== undefined) writeInput.connection_id = existing.connection_id;
    if (existing.source_record_hash !== undefined) writeInput.source_record_hash = existing.source_record_hash;
    if (existing.source_version_token !== undefined) writeInput.source_version_token = existing.source_version_token;
    if (existing.source_updated_at !== undefined) writeInput.source_updated_at = existing.source_updated_at;
    if (existing.source_extension_blob !== undefined) writeInput.source_extension_blob = existing.source_extension_blob;
    const task = deps.store.writeTask(writeInput, now);
    // PA4 — emission discipline:
    //  - `updated` always fires (callers diff via prev.prior).
    //  - `completed` fires only on the false → true transition so
    //    recipes subscribing to `data.work.task.item.completed`
    //    don't fire a second time when the user re-saves a done task.
    //  - Un-complete (true → false) fires only the `updated` event;
    //    no inverse "uncompleted" kind ships.
    emitWorkEntityEvent(
      deps,
      'task',
      'updated',
      tagWorkEntity('task', task),
      tagWorkEntity('task', existing),
    );
    if (done && !existing.done) {
      emitWorkEntityEvent(
        deps,
        'task',
        'completed',
        tagWorkEntity('task', task),
        tagWorkEntity('task', existing),
      );
    }
    cascadeOnWrite(deps, 'task', task.id, 'update');
    if (route !== null && sourceReg !== null) {
      await dispatchVendorWrite(deps, sourceReg, 'task', route, {
        local_id: existing.id,
        prior: existing,
        current: task,
      });
      const refreshed = deps.store.readTask(existing.id);
      if (refreshed !== null) return { task: refreshed };
    }
    return { task };
  };

// ────────────────────────────────────────────────────────────────
// note-* dispatchers
// ────────────────────────────────────────────────────────────────

const noteCreate = (deps: WorkEntityIngredientDeps) =>
  async (input: {
    body: string;
    title?: string;
    /** Create-or-reuse on one stable local id (`idempotentCreateKey`). */
    idempotency_key?: string;
    related_contact_ids?: readonly string[];
    related_calendar_event_ids?: readonly string[];
    related_mail_thread_ids?: readonly string[];
    related_project_ids?: readonly string[];
    source_id?: string;
    source_extension_blob?: Record<string, unknown>;
    /** D-192 6c.2c — caller-named vendor containers by dependency ref. */
    container_names?: Record<string, string>;
  } & WorkEntityCreateOrigin): Promise<{ note: Note }> => {
    // The storage layer allows an empty body (a source-mirrored note
    // never carries complete remote content — D-192 P6); a USER-facing
    // create still requires one.
    if (typeof input.body !== 'string' || input.body.length === 0) {
      throw new WorkEntityValidationError('body is required', 'body');
    }
    const idempotent = idempotentCreateKey('note', input.idempotency_key, input.source_id);
    const source = resolveCreateSource(
      deps,
      'note',
      idempotent === null ? input.source_id : RECUED_BUILTIN_SOURCE_ID('note'),
      input,
    );
    const route = await prepareVendorWrite(deps, source, 'note', 'create', {
      title: input.title,
      body: input.body,
    }, {
      ...(input.container_names !== undefined ? { named: input.container_names } : {}),
      ...(input.work_entity_write_preadmitted === true ? { preadmitted: true } : {}),
      // D-192 baseline-admission (S2) — the run's execution source (unforgeable, set by
      // `withCreateOrigin` from StepMeta) so a vendor create admits past `'ask'` when the
      // OWNER / a granting DOOR governs the run.
      ...(input.origin_execution_source !== undefined
        ? { execution_source: input.origin_execution_source }
        : {}),
    });
    if (source.sync_posture === 'read_through') {
      refuseUnroutableReadThroughCreateFields(source, 'note', {
        related_contact_ids: input.related_contact_ids,
        related_calendar_event_ids: input.related_calendar_event_ids,
        related_mail_thread_ids: input.related_mail_thread_ids,
        related_project_ids: input.related_project_ids,
        source_extension_blob: input.source_extension_blob,
      });
      if (route === null) {
        throw new WorkEntityWriteCapabilityError(
          source.id,
          'note',
          'a read-through Source has no local-only create lane',
        );
      }
      const created = await dispatchReadThroughCreateWrite(deps, source, 'note', route);
      if (created.projected.kind !== 'note') {
        throw new WorkEntityVendorWriteError(
          source.id, 'note', 'error',
          'verified read-through create returned no note projection', false,
        );
      }
      return {
        note: projectReadThroughWriteEntity(
          created.projected,
          created.qualified_id,
          deps.now?.() ?? Date.now(),
        ) as Note,
      };
    }
    const vendor = route !== null
      ? await dispatchVendorWrite(deps, source, 'note', route)
      : null;
    const writeInput: NoteWriteInput = {
      source_id: source.id,
      body: input.body,
    };
    if (idempotent !== null) writeInput.id = idempotent.id;
    if (input.title !== undefined) writeInput.title = input.title;
    if (input.related_contact_ids !== undefined) writeInput.related_contact_ids = input.related_contact_ids;
    if (input.related_calendar_event_ids !== undefined) writeInput.related_calendar_event_ids = input.related_calendar_event_ids;
    if (input.related_mail_thread_ids !== undefined) writeInput.related_mail_thread_ids = input.related_mail_thread_ids;
    if (input.related_project_ids !== undefined) writeInput.related_project_ids = input.related_project_ids;
    if (input.source_extension_blob != null) writeInput.source_extension_blob = input.source_extension_blob;
    if (vendor !== null && vendor.ok && vendor.operation === 'create') {
      writeInput.source_record_id = vendor.source_record_id;
      applyCreateStamp(writeInput, vendor.stamp);
    }
    if (idempotent !== null) {
      writeInput.source_extension_blob = {
        ...(writeInput.source_extension_blob ?? {}),
        [IDEMPOTENCY_MARK.note]: idempotent.key,
      };
      const ensured = deps.store.ensureNote(writeInput as NoteWriteInput & { id: string }, deps.now?.());
      if (!ensured.created) {
        verifyIdempotentReuse('note', ensured.note, idempotent.key);
        return { note: ensured.note };
      }
      emitWorkEntityEvent(deps, 'note', 'created', tagWorkEntity('note', ensured.note));
      return { note: ensured.note };
    }
    const note = deps.store.writeNote(writeInput, deps.now?.());
    emitWorkEntityEvent(deps, 'note', 'created', tagWorkEntity('note', note));
    return { note };
  };

const noteUpdate = (deps: WorkEntityIngredientDeps) =>
  async (input: {
    id: string;
    body?: string;
    title?: string;
    related_contact_ids?: readonly string[];
    related_calendar_event_ids?: readonly string[];
    related_mail_thread_ids?: readonly string[];
    related_project_ids?: readonly string[];
    source_extension_blob?: Record<string, unknown>;
  }): Promise<{ note: Note }> => {
    // An explicit empty-body patch is a user-facing validation error
    // (the storage layer allows `''` for the mirror lane only).
    if (input.body !== undefined && (typeof input.body !== 'string' || input.body.length === 0)) {
      throw new WorkEntityValidationError('body is required', 'body');
    }
    const readThrough = resolveReadThroughWriteTarget(deps, 'note', input.id);
    if (readThrough !== null) {
      const projected = await dispatchReadThroughVendorWrite(
        deps,
        readThrough,
        'note',
        'update',
        {
          body: input.body,
          title: input.title,
          related_contact_ids: input.related_contact_ids,
          related_calendar_event_ids: input.related_calendar_event_ids,
          related_mail_thread_ids: input.related_mail_thread_ids,
          related_project_ids: input.related_project_ids,
          source_extension_blob: input.source_extension_blob,
        },
      );
      if (projected === null || projected.kind !== 'note') {
        throw new WorkEntityVendorWriteError(
          readThrough.source.id,
          'note',
          'error',
          'verified read-through update returned no note projection',
          false,
        );
      }
      return {
        note: projectReadThroughWriteEntity(
          projected,
          readThrough.qualified_id,
          deps.now?.() ?? Date.now(),
        ) as Note,
      };
    }
    const localId = resolveWorkEntityInputId(deps, 'note', input.id);
    const existing = deps.store.readNote(localId);
    if (!existing) throw new WorkEntityNotFoundError('note', input.id);
    const sourceReg = deps.store.getSource(existing.source_id);
    // Phase 1 BEFORE the local write — a structurally-unpushable
    // Source refuses here (no silent local edit); a vendor-relevant
    // patch dispatches AFTER the local write + events (local-first).
    const route = sourceReg !== null
      ? await prepareVendorWrite(deps, sourceReg, 'note', 'update', {
          title: input.title,
          body: input.body,
        })
      : null;
    const now = deps.now?.() ?? Date.now();
    // Note `last_user_action_at` advances on explicit edits per § A.1.2.
    const writeInput: NoteWriteInput = {
      id: existing.id,
      body: input.body ?? existing.body,
      source_id: existing.source_id,
      created_at: existing.created_at,
      last_user_action_at: now,
      sync_state: existing.sync_state,
      conflict_policy: existing.conflict_policy,
    };
    if (input.title !== undefined) writeInput.title = input.title;
    else if (existing.title !== undefined) writeInput.title = existing.title;
    writeInput.related_contact_ids = input.related_contact_ids ?? existing.related_contact_ids;
    writeInput.related_calendar_event_ids = input.related_calendar_event_ids ?? existing.related_calendar_event_ids;
    writeInput.related_mail_thread_ids = input.related_mail_thread_ids ?? existing.related_mail_thread_ids;
    writeInput.related_project_ids = input.related_project_ids ?? existing.related_project_ids;
    if (existing.source_record_id !== undefined) writeInput.source_record_id = existing.source_record_id;
    if (existing.connection_id !== undefined) writeInput.connection_id = existing.connection_id;
    if (existing.source_record_hash !== undefined) writeInput.source_record_hash = existing.source_record_hash;
    if (existing.source_version_token !== undefined) writeInput.source_version_token = existing.source_version_token;
    if (existing.source_updated_at !== undefined) writeInput.source_updated_at = existing.source_updated_at;
    const nextSourceExtensionBlob =
      input.source_extension_blob ?? existing.source_extension_blob;
    if (nextSourceExtensionBlob !== undefined) {
      writeInput.source_extension_blob = nextSourceExtensionBlob;
    }
    const note = deps.store.writeNote(writeInput, now);
    emitWorkEntityEvent(
      deps,
      'note',
      'updated',
      tagWorkEntity('note', note),
      tagWorkEntity('note', existing),
    );
    cascadeOnWrite(deps, 'note', note.id, 'update');
    if (route !== null && sourceReg !== null) {
      await dispatchVendorWrite(deps, sourceReg, 'note', route, {
        local_id: existing.id,
        prior: existing,
        current: note,
      });
      const refreshed = deps.store.readNote(existing.id);
      if (refreshed !== null) return { note: refreshed };
    }
    return { note };
  };

const noteDelete = (deps: WorkEntityIngredientDeps) =>
  async (input: { id: string; tombstone?: boolean }): Promise<{
    ok: true;
    id: string;
    tombstoned: boolean;
  }> => {
    const readThrough = resolveReadThroughWriteTarget(deps, 'note', input.id);
    if (readThrough !== null) {
      await dispatchReadThroughVendorWrite(deps, readThrough, 'note', 'delete', {});
      return { ok: true as const, id: input.id, tombstoned: false };
    }
    const localId = resolveWorkEntityInputId(deps, 'note', input.id);
    const existing = deps.store.readNote(localId);
    if (!existing) throw new WorkEntityNotFoundError('note', input.id);
    const tombstone = input.tombstone !== false;
    const sourceReg = deps.store.getSource(existing.source_id);
    // Delete stays VENDOR-FIRST: a local-first tombstone against a
    // live vendor record would be resurrected by the next sync cycle.
    if (sourceReg) {
      const route = await prepareVendorWrite(deps, sourceReg, 'note', 'delete', {});
      if (route !== null) {
        await dispatchVendorWrite(deps, sourceReg, 'note', route, {
          local_id: existing.id,
          prior: existing,
          current: existing,
        });
      }
    }
    const ok = deps.store.deleteNote(localId, { tombstone, ...(deps.now ? { now: deps.now() } : {}) });
    if (!ok) throw new WorkEntityNotFoundError('note', input.id);
    emitWorkEntityEvent(deps, 'note', 'deleted', tagWorkEntity('note', existing), tagWorkEntity('note', existing));
    cascadeOnWrite(deps, 'note', existing.id, 'delete');
    return { ok: true as const, id: input.id, tombstoned: tombstone };
  };

// ────────────────────────────────────────────────────────────────
// commitment-* dispatchers (with state machine)
// ────────────────────────────────────────────────────────────────

const commitmentCreate = (deps: WorkEntityIngredientDeps) =>
  async (input: {
    direction: import('@recued/contracts').CommitmentDirection;
    statement: string;
    /** Create-or-reuse on one stable local id (`idempotentCreateKey`). */
    idempotency_key?: string;
    derivation: import('@recued/contracts').CommitmentDerivation;
    promised_at?: number;
    promised_for_at?: number;
    expiry_policy?: import('@recued/contracts').CommitmentExpiryPolicy;
    derivation_confidence?: number;
    monetary_value?: import('@recued/contracts').MonetaryValue;
    counterparty_contact_id?: string;
    derived_from_mail_thread_id?: string;
    derived_from_meeting_id?: string;
    blocks_task_ids?: readonly string[];
    blocks_project_ids?: readonly string[];
    source_id?: string;
    source_extension_blob?: Record<string, unknown>;
    evidence_blob?: readonly import('@recued/contracts').CommitmentEvidenceEntry[];
  } & WorkEntityCreateOrigin): Promise<{ commitment: Commitment }> => {
    input = withDateInputs(input, ['promised_at', 'promised_for_at']);
    const idempotent = idempotentCreateKey('commitment', input.idempotency_key, input.source_id);
    const source = resolveCreateSource(
      deps,
      'commitment',
      idempotent === null ? input.source_id : RECUED_BUILTIN_SOURCE_ID('commitment'),
      input,
    );
    // D-192 F1 — invariant 1 pinned at mint, BOTH directions: an
    // `evidence_captured` commitment must bind evidence (no evidence,
    // no commitment), and evidence only rides `evidence_captured`
    // (authored derivations never carry capture snapshots — that would
    // dress an authored claim as captured provenance).
    if (input.derivation === 'evidence_captured' && input.evidence_blob == null) {
      throw new WorkEntityValidationError(
        "derivation 'evidence_captured' requires evidence_blob (no evidence, no commitment)",
        'evidence_blob',
      );
    }
    if (input.evidence_blob != null && input.derivation !== 'evidence_captured') {
      throw new WorkEntityValidationError(
        "evidence_blob rides derivation 'evidence_captured' only",
        'evidence_blob',
      );
    }
    // Commitments never sync through the Source mirror substrate — a
    // connection-derived commitment Source config-refuses at prepare;
    // built-in passes the capability check and lands locally.
    await prepareVendorWrite(deps, source, 'commitment', 'create', {
      statement: input.statement,
    });
    const writeInput: CommitmentWriteInput = {
      source_id: source.id,
      direction: input.direction,
      statement: input.statement,
      derivation: input.derivation,
    };
    if (idempotent !== null) writeInput.id = idempotent.id;
    // `!= null` treats both `null` and `undefined` as "absent" — recipes
    // routinely surface `null` when an optional step is skipped (e.g.
    // `skip_when` collapsed a monetary-value or due-date branch). The
    // store layer's destructuring + regex checks assume the field is
    // either present-and-valid or absent; routing `null` through would
    // throw at commit time.
    if (input.promised_at != null) writeInput.promised_at = input.promised_at;
    if (input.promised_for_at != null) writeInput.promised_for_at = input.promised_for_at;
    if (input.expiry_policy != null) writeInput.expiry_policy = input.expiry_policy;
    if (input.derivation_confidence != null) writeInput.derivation_confidence = input.derivation_confidence;
    if (input.monetary_value != null) writeInput.monetary_value = input.monetary_value;
    if (input.counterparty_contact_id != null) writeInput.counterparty_contact_id = input.counterparty_contact_id;
    if (input.derived_from_mail_thread_id != null && input.derived_from_mail_thread_id !== '') {
      writeInput.derived_from_mail_thread_id = input.derived_from_mail_thread_id;
    }
    if (input.derived_from_meeting_id != null) writeInput.derived_from_meeting_id = input.derived_from_meeting_id;
    if (input.blocks_task_ids != null) {
      writeInput.blocks_task_ids = input.blocks_task_ids.map((id) =>
        resolveWorkEntityInputId(deps, 'task', id));
    }
    if (input.blocks_project_ids != null) {
      writeInput.blocks_project_ids = input.blocks_project_ids.map((id) =>
        resolveWorkEntityInputId(deps, 'project', id));
    }
    if (input.source_extension_blob != null) writeInput.source_extension_blob = input.source_extension_blob;
    // D-192 F1 — evidence snapshots ride create-only (the store
    // validates shape + cap; updates can never touch the lane).
    if (input.evidence_blob != null) writeInput.evidence_blob = input.evidence_blob;
    if (idempotent !== null) {
      writeInput.source_extension_blob = {
        ...(writeInput.source_extension_blob ?? {}),
        [IDEMPOTENCY_MARK.commitment]: idempotent.key,
      };
      const ensured = deps.store.ensureCommitment(
        writeInput as CommitmentWriteInput & { id: string },
        deps.now?.(),
      );
      if (!ensured.created) {
        verifyIdempotentReuse('commitment', ensured.commitment, idempotent.key);
        return { commitment: ensured.commitment };
      }
      emitWorkEntityEvent(deps, 'commitment', 'created', tagWorkEntity('commitment', ensured.commitment));
      return { commitment: ensured.commitment };
    }
    const commitment = deps.store.writeCommitment(writeInput, deps.now?.());
    emitWorkEntityEvent(deps, 'commitment', 'created', tagWorkEntity('commitment', commitment));
    return { commitment };
  };

const commitmentUpdate = (deps: WorkEntityIngredientDeps) =>
  async (input: {
    id: string;
    statement?: string;
    promised_for_at?: number;
    expiry_policy?: import('@recued/contracts').CommitmentExpiryPolicy;
    monetary_value?: import('@recued/contracts').MonetaryValue;
    counterparty_contact_id?: string;
    derivation_confidence?: number;
    blocks_task_ids?: readonly string[];
    blocks_project_ids?: readonly string[];
    source_extension_blob?: Record<string, unknown>;
  }): Promise<{ commitment: Commitment }> => {
    input = withDateInputs(input, ['promised_for_at']);
    const localId = resolveWorkEntityInputId(deps, 'commitment', input.id);
    const existing = deps.store.readCommitment(localId);
    if (!existing) throw new WorkEntityNotFoundError('commitment', input.id);
    const sourceReg = deps.store.getSource(existing.source_id);
    if (sourceReg) {
      await prepareVendorWrite(deps, sourceReg, 'commitment', 'update', {
        statement: input.statement,
      });
    }
    // Codex P1 fold — `promised_for_at` shifts (reschedule) recompute
    // due_status at dispatcher write time so the bus + storage row
    // reflect the new deadline immediately instead of waiting for the
    // next sweep cycle. The sweep is forward-only (per spec § A.1.3 —
    // back-transitions like `overdue → due_soon` only happen via
    // reschedule), so the dispatcher is the only path that triggers
    // back-transitions.
    const nextPromisedForAt =
      input.promised_for_at !== undefined ? input.promised_for_at : existing.promised_for_at;
    const now = deps.now?.() ?? Date.now();
    let nextDueStatus: CommitmentDueStatus = existing.due_status;
    let dueStatusChangedAt = existing.due_status_changed_at;
    let stateChangedAt = existing.state_changed_at;
    // Only recompute when `promised_for_at` actually moves AND the
    // commitment is still pending (terminal lifecycle states freeze
    // both axes). The classifier is a pure function of the new
    // deadline + clock; missing deadline → `'no_deadline'`.
    if (
      input.promised_for_at !== undefined
      && existing.lifecycle_state === 'pending'
      && input.promised_for_at !== existing.promised_for_at
    ) {
      const classified = classifyCommitmentDueStatus(
        { promised_for_at: nextPromisedForAt, due_status: existing.due_status },
        now,
        undefined,
        deps.timeZone?.(),
      );
      if (classified !== existing.due_status) {
        nextDueStatus = classified;
        dueStatusChangedAt = now;
        stateChangedAt = now;
      }
    }
    const writeInput: CommitmentWriteInput = {
      id: existing.id,
      direction: existing.direction,
      statement: input.statement ?? existing.statement,
      derivation: existing.derivation,
      source_id: existing.source_id,
      created_at: existing.created_at,
      promised_at: existing.promised_at,
      lifecycle_state: existing.lifecycle_state,
      due_status: nextDueStatus,
      expiry_policy: input.expiry_policy ?? existing.expiry_policy,
      state_changed_at: stateChangedAt,
      lifecycle_changed_at: existing.lifecycle_changed_at,
      due_status_changed_at: dueStatusChangedAt,
      sync_state: existing.sync_state,
      conflict_policy: existing.conflict_policy,
      blocks_task_ids: input.blocks_task_ids?.map((id) =>
        resolveWorkEntityInputId(deps, 'task', id)
      ) ?? existing.blocks_task_ids,
      blocks_project_ids: input.blocks_project_ids?.map((id) =>
        resolveWorkEntityInputId(deps, 'project', id)
      ) ?? existing.blocks_project_ids,
    };
    if (input.promised_for_at !== undefined) writeInput.promised_for_at = input.promised_for_at;
    else if (existing.promised_for_at !== undefined) writeInput.promised_for_at = existing.promised_for_at;
    if (input.monetary_value !== undefined) writeInput.monetary_value = input.monetary_value;
    else if (existing.monetary_value !== undefined) writeInput.monetary_value = existing.monetary_value;
    if (input.counterparty_contact_id !== undefined) writeInput.counterparty_contact_id = input.counterparty_contact_id;
    else if (existing.counterparty_contact_id !== undefined) writeInput.counterparty_contact_id = existing.counterparty_contact_id;
    if (input.derivation_confidence !== undefined) writeInput.derivation_confidence = input.derivation_confidence;
    else if (existing.derivation_confidence !== undefined) writeInput.derivation_confidence = existing.derivation_confidence;
    if (existing.derived_from_mail_thread_id !== undefined) writeInput.derived_from_mail_thread_id = existing.derived_from_mail_thread_id;
    if (existing.derived_from_meeting_id !== undefined) writeInput.derived_from_meeting_id = existing.derived_from_meeting_id;
    if (existing.source_record_id !== undefined) writeInput.source_record_id = existing.source_record_id;
    if (existing.connection_id !== undefined) writeInput.connection_id = existing.connection_id;
    if (existing.source_record_hash !== undefined) writeInput.source_record_hash = existing.source_record_hash;
    if (existing.source_version_token !== undefined) writeInput.source_version_token = existing.source_version_token;
    if (existing.source_updated_at !== undefined) writeInput.source_updated_at = existing.source_updated_at;
    const nextSourceExtensionBlob =
      input.source_extension_blob ?? existing.source_extension_blob;
    if (nextSourceExtensionBlob !== undefined) {
      writeInput.source_extension_blob = nextSourceExtensionBlob;
    }
    const commitment = deps.store.writeCommitment(writeInput, now);
    emitWorkEntityEvent(
      deps,
      'commitment',
      'updated',
      tagWorkEntity('commitment', commitment),
      tagWorkEntity('commitment', existing),
    );
    // Codex P1 fold — when reschedule triggered a due_status move,
    // emit the corresponding bus event so subscribers see the
    // transition (consistent with the sweep-driven path that fires
    // due_soon / overdue when crossings happen).
    if (nextDueStatus !== existing.due_status) {
      if (nextDueStatus === 'due_soon') {
        emitWorkEntityEvent(
          deps,
          'commitment',
          'due_soon',
          tagWorkEntity('commitment', commitment),
          tagWorkEntity('commitment', existing),
        );
      } else if (nextDueStatus === 'overdue') {
        emitWorkEntityEvent(
          deps,
          'commitment',
          'overdue',
          tagWorkEntity('commitment', commitment),
          tagWorkEntity('commitment', existing),
        );
      }
      // `not_due` / `no_deadline` back-transitions don't ride a
      // dedicated reactive kind — recipes that care can listen on
      // `data.work.commitment.item.updated` and diff prev.prior vs
      // record. (The spec transition table allows the back-transition
      // but doesn't list a discrete event for it.)
    }
    cascadeOnWrite(deps, 'commitment', commitment.id, 'update');
    return { commitment };
  };

const commitmentLifecycleMove = (
  deps: WorkEntityIngredientDeps,
  to: 'fulfilled' | 'cancelled',
) => async (input: { id: string; fulfilled_at?: number; cancelled_at?: number }): Promise<{
  commitment: Commitment;
}> => {
  const localId = resolveWorkEntityInputId(deps, 'commitment', input.id);
  const existing = deps.store.readCommitment(localId);
  if (!existing) throw new WorkEntityNotFoundError('commitment', input.id);
  const allowedFromStates = to === 'fulfilled'
    ? COMMITMENT_FULFILL_FROM_STATES
    : COMMITMENT_CANCEL_FROM_STATES;
  if (!allowedFromStates.has(existing.lifecycle_state)) {
    throw new CommitmentLifecycleError(
      input.id,
      existing.lifecycle_state,
      to,
      existing.lifecycle_state === 'fulfilled' || existing.lifecycle_state === 'cancelled'
        ? `commitment is already in terminal state '${existing.lifecycle_state}'`
        : `transition not allowed from '${existing.lifecycle_state}'`,
    );
  }
  // § A.1.3 — `expired → fulfilled` is the load-bearing constraint.
  // Only `escalate_overdue` and `indefinite` policies allow lifting an
  // expired commitment back to fulfilled; `strict_expire` commitments
  // stay terminal at the deadline.
  if (
    to === 'fulfilled'
    && existing.lifecycle_state === 'expired'
    && !COMMITMENT_FULFILL_ALLOWED_EXPIRY_POLICIES.has(existing.expiry_policy)
  ) {
    throw new CommitmentLifecycleError(
      input.id,
      'expired',
      'fulfilled',
      `expiry_policy '${existing.expiry_policy}' does not permit fulfilling an expired commitment`
        + ` (only 'escalate_overdue' and 'indefinite' do)`,
    );
  }
  const sourceReg = deps.store.getSource(existing.source_id);
  if (sourceReg) {
    await prepareVendorWrite(deps, sourceReg, 'commitment', 'update', {});
  }
  const now = deps.now?.() ?? Date.now();
  const stamp = to === 'fulfilled' ? input.fulfilled_at ?? now : input.cancelled_at ?? now;
  const writeInput: CommitmentWriteInput = {
    id: existing.id,
    direction: existing.direction,
    statement: existing.statement,
    derivation: existing.derivation,
    source_id: existing.source_id,
    created_at: existing.created_at,
    promised_at: existing.promised_at,
    lifecycle_state: to,
    due_status: existing.due_status,
    expiry_policy: existing.expiry_policy,
    state_changed_at: stamp,
    lifecycle_changed_at: stamp,
    due_status_changed_at: existing.due_status_changed_at,
    sync_state: existing.sync_state,
    conflict_policy: existing.conflict_policy,
    blocks_task_ids: existing.blocks_task_ids,
    blocks_project_ids: existing.blocks_project_ids,
  };
  if (existing.promised_for_at !== undefined) writeInput.promised_for_at = existing.promised_for_at;
  if (existing.derivation_confidence !== undefined) writeInput.derivation_confidence = existing.derivation_confidence;
  if (existing.monetary_value !== undefined) writeInput.monetary_value = existing.monetary_value;
  if (existing.counterparty_contact_id !== undefined) writeInput.counterparty_contact_id = existing.counterparty_contact_id;
  if (existing.derived_from_mail_thread_id !== undefined) writeInput.derived_from_mail_thread_id = existing.derived_from_mail_thread_id;
  if (existing.derived_from_meeting_id !== undefined) writeInput.derived_from_meeting_id = existing.derived_from_meeting_id;
  if (existing.source_record_id !== undefined) writeInput.source_record_id = existing.source_record_id;
  if (existing.connection_id !== undefined) writeInput.connection_id = existing.connection_id;
  if (existing.source_record_hash !== undefined) writeInput.source_record_hash = existing.source_record_hash;
  if (existing.source_version_token !== undefined) writeInput.source_version_token = existing.source_version_token;
  if (existing.source_updated_at !== undefined) writeInput.source_updated_at = existing.source_updated_at;
  if (existing.source_extension_blob !== undefined) writeInput.source_extension_blob = existing.source_extension_blob;
  const commitment = deps.store.writeCommitment(writeInput, now);
  // PA4 — emission discipline:
  //  - `updated` always fires (callers diff via prev.prior).
  //  - `state_changed` fires only when lifecycle actually transitioned
  //    (the gate above already rejects same-state moves, so reaching
  //    here means existing.lifecycle_state !== to). Recipes
  //    subscribing to `data.work.commitment.item.state_changed` see
  //    one fire per real lifecycle move.
  emitWorkEntityEvent(
    deps,
    'commitment',
    'updated',
    tagWorkEntity('commitment', commitment),
    tagWorkEntity('commitment', existing),
  );
  emitWorkEntityEvent(
    deps,
    'commitment',
    'state_changed',
    tagWorkEntity('commitment', commitment),
    tagWorkEntity('commitment', existing),
  );
  cascadeOnWrite(deps, 'commitment', commitment.id, 'update');
  return { commitment };
};

/** D-174 #22 — commitment delete (tombstone-by-default), the
 *  RPC-channel counterpart of `task-delete` / `note-delete`. The 14
 *  PA3 kernel ingredients deliberately model commitment terminal-state
 *  via the fulfil / cancel lifecycle (monetary commitments must not
 *  silently expire — § A.1.3), NOT a delete slug; but the Data back-
 *  office surface (D-174 D11 — own-it kinds fully manageable) still
 *  needs a user-driven remove for a mis-extracted row. This dispatcher
 *  has NO kernel slug — it is reached only from the `work_entity.delete`
 *  pair-RPC — and emits the same `deleted` warehouse event + cascade as
 *  the task/note deletes so reactive recipes + enrichment invalidation
 *  fire uniformly. */
const commitmentDelete = (deps: WorkEntityIngredientDeps) =>
  async (input: { id: string; tombstone?: boolean }): Promise<{
    ok: true;
    id: string;
    tombstoned: boolean;
  }> => {
    const localId = resolveWorkEntityInputId(deps, 'commitment', input.id);
    const existing = deps.store.readCommitment(localId);
    if (!existing) throw new WorkEntityNotFoundError('commitment', input.id);
    const tombstone = input.tombstone !== false;
    const sourceReg = deps.store.getSource(existing.source_id);
    if (sourceReg) {
      await prepareVendorWrite(deps, sourceReg, 'commitment', 'delete', {});
    }
    const ok = deps.store.deleteCommitment(localId, { tombstone, ...(deps.now ? { now: deps.now() } : {}) });
    if (!ok) throw new WorkEntityNotFoundError('commitment', input.id);
    emitWorkEntityEvent(
      deps,
      'commitment',
      'deleted',
      tagWorkEntity('commitment', existing),
      tagWorkEntity('commitment', existing),
    );
    cascadeOnWrite(deps, 'commitment', existing.id, 'delete');
    return { ok: true as const, id: input.id, tombstoned: tombstone };
  };

// ────────────────────────────────────────────────────────────────
// booking-* dispatchers (D-210)
// ────────────────────────────────────────────────────────────────
//
// ⚠ NO `prepareVendorWrite` / `dispatchVendorWrite` leg, unlike every
// other kind. A booking is Recued-LOCAL by construction: it is minted
// when the owner approves a reservation through their own Reception
// door, so there is no upstream vendor record to push to and none to
// reconcile against. `booking` is deliberately absent from
// `WORK_ENTITY_SOURCE_DECLARABLE_KINDS`, so routing one through the
// mirror substrate would config-fail anyway — omitting the leg makes
// that a structural fact rather than a runtime refusal.

const bookingCreate = (deps: WorkEntityIngredientDeps) =>
  async (input: {
    title: string;
    lifecycle_state?: BookingLifecycleState;
    slot_start_at?: number;
    slot_end_at?: number;
    monetary_value?: MonetaryValue;
    counterparty_contact_id?: string;
    reception_record_id?: string;
    source_id?: string;
    source_extension_blob?: Record<string, unknown>;
  } & WorkEntityCreateOrigin): Promise<{ booking: Booking }> => {
    input = withDateInputs(input, ['slot_start_at', 'slot_end_at']);
    const source = resolveCreateSource(deps, 'booking', input.source_id, input);
    const writeInput: BookingWriteInput = {
      source_id: source.id,
      title: input.title,
    };
    if (input.lifecycle_state !== undefined) writeInput.lifecycle_state = input.lifecycle_state;
    // Passed through INDEPENDENTLY rather than as a pre-checked pair: the
    // store owns both-or-neither and throws with the field names, so a
    // half-supplied slot surfaces as one error from one place instead of
    // two rules that can drift apart.
    if (input.slot_start_at !== undefined) writeInput.slot_start_at = input.slot_start_at;
    if (input.slot_end_at !== undefined) writeInput.slot_end_at = input.slot_end_at;
    if (input.monetary_value !== undefined) writeInput.monetary_value = input.monetary_value;
    if (input.counterparty_contact_id !== undefined)
      writeInput.counterparty_contact_id = input.counterparty_contact_id;
    if (input.reception_record_id !== undefined)
      writeInput.reception_record_id = input.reception_record_id;
    if (input.source_extension_blob != null)
      writeInput.source_extension_blob = input.source_extension_blob;
    const booking = deps.store.writeBooking(writeInput, deps.now?.());
    emitWorkEntityEvent(deps, 'booking', 'created', tagWorkEntity('booking', booking));
    return { booking };
  };

const bookingUpdate = (deps: WorkEntityIngredientDeps) =>
  async (input: {
    id: string;
    title?: string;
    lifecycle_state?: BookingLifecycleState;
    slot_start_at?: number;
    slot_end_at?: number;
    monetary_value?: MonetaryValue;
    counterparty_contact_id?: string;
    source_extension_blob?: Record<string, unknown>;
  }): Promise<{ booking: Booking }> => {
    input = withDateInputs(input, ['slot_start_at', 'slot_end_at']);
    const localId = resolveWorkEntityInputId(deps, 'booking', input.id);
    const existing = deps.store.readBooking(localId);
    if (!existing) throw new WorkEntityNotFoundError('booking', input.id);
    const now = deps.now?.() ?? Date.now();
    // A lifecycle move re-stamps `state_changed_at`; a metadata-only
    // edit must NOT, or "when did this booking become a no-show?"
    // silently becomes "when was it last touched".
    const moved =
      input.lifecycle_state !== undefined && input.lifecycle_state !== existing.lifecycle_state;
    const writeInput: BookingWriteInput = {
      id: existing.id,
      source_id: existing.source_id,
      title: input.title ?? existing.title,
      lifecycle_state: input.lifecycle_state ?? existing.lifecycle_state,
      created_at: existing.created_at,
      state_changed_at: moved ? now : existing.state_changed_at,
    };
    // `?? existing` on each optional so an omitted key PRESERVES rather
    // than clears — the store write is a full-row upsert.
    //
    // ⚠ THE SLOT IS THE EXCEPTION: it moves as a PAIR, never field-by-
    // field. Preserving half of it is not a smaller edit, it is a
    // DIFFERENT booking — supply only a new start against a kept end and
    // a 60-minute booking silently becomes a 30-minute one, at
    // `success: true`. Half-supplied is refused; omitted-entirely
    // preserves both, matching every other field here.
    const slotFieldSupplied =
      input.slot_start_at !== undefined || input.slot_end_at !== undefined;
    if (slotFieldSupplied) {
      if (input.slot_start_at === undefined || input.slot_end_at === undefined) {
        throw new Error(
          'booking-update: slot_start_at and slot_end_at move together — supply both to reschedule, or neither to leave the time alone',
        );
      }
      writeInput.slot_start_at = input.slot_start_at;
      writeInput.slot_end_at = input.slot_end_at;
    } else if (existing.slot_start_at !== undefined && existing.slot_end_at !== undefined) {
      writeInput.slot_start_at = existing.slot_start_at;
      writeInput.slot_end_at = existing.slot_end_at;
    }
    const monetary_value = input.monetary_value ?? existing.monetary_value;
    if (monetary_value !== undefined) writeInput.monetary_value = monetary_value;
    const counterparty = input.counterparty_contact_id ?? existing.counterparty_contact_id;
    if (counterparty !== undefined) writeInput.counterparty_contact_id = counterparty;
    // Provenance is write-once — the reception record a booking came
    // from is a historical fact, not an editable field.
    if (existing.reception_record_id !== undefined)
      writeInput.reception_record_id = existing.reception_record_id;
    const blob = input.source_extension_blob ?? existing.source_extension_blob;
    if (blob != null) writeInput.source_extension_blob = blob;
    const booking = deps.store.writeBooking(writeInput, now);
    emitWorkEntityEvent(
      deps,
      'booking',
      'updated',
      tagWorkEntity('booking', booking),
      tagWorkEntity('booking', existing),
    );
    if (moved) {
      emitWorkEntityEvent(
        deps,
        'booking',
        'state_changed',
        tagWorkEntity('booking', booking),
        tagWorkEntity('booking', existing),
      );
    }
    cascadeOnWrite(deps, 'booking', booking.id, 'update');
    return { booking };
  };

const bookingDelete = (deps: WorkEntityIngredientDeps) =>
  async (input: { id: string; tombstone?: boolean }): Promise<{
    ok: true;
    id: string;
    tombstoned: boolean;
  }> => {
    const localId = resolveWorkEntityInputId(deps, 'booking', input.id);
    const existing = deps.store.readBooking(localId);
    if (!existing) throw new WorkEntityNotFoundError('booking', input.id);
    const tombstone = input.tombstone !== false;
    const ok = deps.store.deleteBooking(localId, {
      tombstone,
      ...(deps.now ? { now: deps.now() } : {}),
    });
    if (!ok) throw new WorkEntityNotFoundError('booking', input.id);
    emitWorkEntityEvent(
      deps,
      'booking',
      'deleted',
      tagWorkEntity('booking', existing),
      tagWorkEntity('booking', existing),
    );
    cascadeOnWrite(deps, 'booking', existing.id, 'delete');
    return { ok: true as const, id: input.id, tombstoned: tombstone };
  };

// ────────────────────────────────────────────────────────────────
// project-* dispatchers
// ────────────────────────────────────────────────────────────────

const projectCreate = (deps: WorkEntityIngredientDeps) =>
  async (input: {
    title: string;
    /** Create-or-reuse on one stable local id (`idempotentCreateKey`). */
    idempotency_key?: string;
    description?: string;
    state?: import('@recued/contracts').ProjectState;
    target_completion_at?: number;
    related_contact_ids?: readonly string[];
    parent_project_id?: string;
    source_id?: string;
    source_extension_blob?: Record<string, unknown>;
    /** D-192 6c.2c — caller-named vendor containers by dependency ref. */
    container_names?: Record<string, string>;
  } & WorkEntityCreateOrigin): Promise<{ project: Project }> => {
    input = withDateInputs(input, ['target_completion_at']);
    const idempotent = idempotentCreateKey('project', input.idempotency_key, input.source_id);
    const source = resolveCreateSource(
      deps,
      'project',
      idempotent === null ? input.source_id : RECUED_BUILTIN_SOURCE_ID('project'),
      input,
    );
    const route = await prepareVendorWrite(deps, source, 'project', 'create', {
      title: input.title,
      description: input.description,
      state: input.state,
      target_completion_at: input.target_completion_at,
    }, {
      ...(input.container_names !== undefined ? { named: input.container_names } : {}),
      ...(input.work_entity_write_preadmitted === true ? { preadmitted: true } : {}),
      // D-192 baseline-admission (S2) — the run's execution source (unforgeable, set by
      // `withCreateOrigin` from StepMeta) so a vendor create admits past `'ask'` when the
      // OWNER / a granting DOOR governs the run.
      ...(input.origin_execution_source !== undefined
        ? { execution_source: input.origin_execution_source }
        : {}),
    });
    if (source.sync_posture === 'read_through') {
      refuseUnroutableReadThroughCreateFields(source, 'project', {
        related_contact_ids: input.related_contact_ids,
        parent_project_id: input.parent_project_id,
        source_extension_blob: input.source_extension_blob,
      });
      if (route === null) {
        throw new WorkEntityWriteCapabilityError(
          source.id,
          'project',
          'a read-through Source has no local-only create lane',
        );
      }
      const created = await dispatchReadThroughCreateWrite(deps, source, 'project', route);
      if (created.projected.kind !== 'project') {
        throw new WorkEntityVendorWriteError(
          source.id, 'project', 'error',
          'verified read-through create returned no project projection', false,
        );
      }
      return {
        project: projectReadThroughWriteEntity(
          created.projected,
          created.qualified_id,
          deps.now?.() ?? Date.now(),
        ) as Project,
      };
    }
    const vendor = route !== null
      ? await dispatchVendorWrite(deps, source, 'project', route)
      : null;
    const writeInput: ProjectWriteInput = {
      source_id: source.id,
      title: input.title,
    };
    if (idempotent !== null) writeInput.id = idempotent.id;
    if (input.description !== undefined) writeInput.description = input.description;
    if (input.state !== undefined) writeInput.state = input.state;
    if (input.target_completion_at !== undefined) writeInput.target_completion_at = input.target_completion_at;
    if (input.related_contact_ids !== undefined) writeInput.related_contact_ids = input.related_contact_ids;
    if (input.parent_project_id !== undefined) {
      writeInput.parent_project_id = resolveWorkEntityInputId(
        deps,
        'project',
        input.parent_project_id,
      );
    }
    if (input.source_extension_blob != null) writeInput.source_extension_blob = input.source_extension_blob;
    if (vendor !== null && vendor.ok && vendor.operation === 'create') {
      writeInput.source_record_id = vendor.source_record_id;
      applyCreateStamp(writeInput, vendor.stamp);
    }
    if (idempotent !== null) {
      writeInput.source_extension_blob = {
        ...(writeInput.source_extension_blob ?? {}),
        [IDEMPOTENCY_MARK.project]: idempotent.key,
      };
      const ensured = deps.store.ensureProject(writeInput as ProjectWriteInput & { id: string }, deps.now?.());
      if (!ensured.created) {
        verifyIdempotentReuse('project', ensured.project, idempotent.key);
        return { project: ensured.project };
      }
      emitWorkEntityEvent(deps, 'project', 'created', tagWorkEntity('project', ensured.project));
      return { project: ensured.project };
    }
    const project = deps.store.writeProject(writeInput, deps.now?.());
    emitWorkEntityEvent(deps, 'project', 'created', tagWorkEntity('project', project));
    return { project };
  };

const projectUpdate = (deps: WorkEntityIngredientDeps) =>
  async (input: {
    id: string;
    title?: string;
    description?: string;
    state?: import('@recued/contracts').ProjectState;
    target_completion_at?: number;
    related_contact_ids?: readonly string[];
    parent_project_id?: string;
    source_extension_blob?: Record<string, unknown>;
  }): Promise<{ project: Project }> => {
    input = withDateInputs(input, ['target_completion_at']);
    const readThrough = resolveReadThroughWriteTarget(deps, 'project', input.id);
    if (readThrough !== null) {
      const projected = await dispatchReadThroughVendorWrite(
        deps,
        readThrough,
        'project',
        'update',
        {
          title: input.title,
          description: input.description,
          state: input.state,
          target_completion_at: input.target_completion_at,
          related_contact_ids: input.related_contact_ids,
          parent_project_id: input.parent_project_id,
          source_extension_blob: input.source_extension_blob,
        },
      );
      if (projected === null || projected.kind !== 'project') {
        throw new WorkEntityVendorWriteError(
          readThrough.source.id,
          'project',
          'error',
          'verified read-through update returned no project projection',
          false,
        );
      }
      return {
        project: projectReadThroughWriteEntity(
          projected,
          readThrough.qualified_id,
          deps.now?.() ?? Date.now(),
        ) as Project,
      };
    }
    const localId = resolveWorkEntityInputId(deps, 'project', input.id);
    const existing = deps.store.readProject(localId);
    if (!existing) throw new WorkEntityNotFoundError('project', input.id);
    const sourceReg = deps.store.getSource(existing.source_id);
    const route = sourceReg !== null
      ? await prepareVendorWrite(deps, sourceReg, 'project', 'update', {
          title: input.title,
          description: input.description,
          state: input.state,
          target_completion_at: input.target_completion_at,
        })
      : null;
    const writeInput: ProjectWriteInput = {
      id: existing.id,
      title: input.title ?? existing.title,
      source_id: existing.source_id,
      created_at: existing.created_at,
      state: input.state ?? existing.state,
      last_activity_at: existing.last_activity_at,
      sync_state: existing.sync_state,
      conflict_policy: existing.conflict_policy,
      related_contact_ids: input.related_contact_ids ?? existing.related_contact_ids,
    };
    if (input.description !== undefined) writeInput.description = input.description;
    else if (existing.description !== undefined) writeInput.description = existing.description;
    if (input.target_completion_at !== undefined) writeInput.target_completion_at = input.target_completion_at;
    else if (existing.target_completion_at !== undefined) writeInput.target_completion_at = existing.target_completion_at;
    if (input.parent_project_id !== undefined) {
      writeInput.parent_project_id = resolveWorkEntityInputId(
        deps,
        'project',
        input.parent_project_id,
      );
    } else if (existing.parent_project_id !== undefined) {
      writeInput.parent_project_id = existing.parent_project_id;
    }
    if (existing.source_record_id !== undefined) writeInput.source_record_id = existing.source_record_id;
    if (existing.connection_id !== undefined) writeInput.connection_id = existing.connection_id;
    if (existing.source_record_hash !== undefined) writeInput.source_record_hash = existing.source_record_hash;
    if (existing.source_version_token !== undefined) writeInput.source_version_token = existing.source_version_token;
    if (existing.source_updated_at !== undefined) writeInput.source_updated_at = existing.source_updated_at;
    const nextSourceExtensionBlob =
      input.source_extension_blob ?? existing.source_extension_blob;
    if (nextSourceExtensionBlob !== undefined) {
      writeInput.source_extension_blob = nextSourceExtensionBlob;
    }
    const project = deps.store.writeProject(writeInput, deps.now?.());
    emitWorkEntityEvent(
      deps,
      'project',
      'updated',
      tagWorkEntity('project', project),
      tagWorkEntity('project', existing),
    );
    if (existing.state !== project.state) {
      emitWorkEntityEvent(
        deps,
        'project',
        'state_changed',
        tagWorkEntity('project', project),
        tagWorkEntity('project', existing),
      );
    }
    cascadeOnWrite(deps, 'project', project.id, 'update');
    if (route !== null && sourceReg !== null) {
      await dispatchVendorWrite(deps, sourceReg, 'project', route, {
        local_id: existing.id,
        prior: existing,
        current: project,
      });
      const refreshed = deps.store.readProject(existing.id);
      if (refreshed !== null) return { project: refreshed };
    }
    return { project };
  };

const projectArchive = (deps: WorkEntityIngredientDeps) =>
  async (input: { id: string }): Promise<{ project: Project }> => {
    const readThrough = resolveReadThroughWriteTarget(deps, 'project', input.id);
    if (readThrough !== null) {
      const projected = await dispatchReadThroughVendorWrite(
        deps,
        readThrough,
        'project',
        'update',
        { state: 'archived' },
      );
      if (projected === null || projected.kind !== 'project') {
        throw new WorkEntityVendorWriteError(
          readThrough.source.id,
          'project',
          'error',
          'verified read-through archive returned no project projection',
          false,
        );
      }
      return {
        project: projectReadThroughWriteEntity(
          projected,
          readThrough.qualified_id,
          deps.now?.() ?? Date.now(),
        ) as Project,
      };
    }
    const localId = resolveWorkEntityInputId(deps, 'project', input.id);
    const existing = deps.store.readProject(localId);
    if (!existing) throw new WorkEntityNotFoundError('project', input.id);
    if (existing.state === 'archived') {
      // Idempotent — already archived. Return the existing record
      // unchanged so recipes that re-fire aren't disturbed.
      return { project: existing };
    }
    const sourceReg = deps.store.getSource(existing.source_id);
    const route = sourceReg !== null
      ? await prepareVendorWrite(deps, sourceReg, 'project', 'update', { state: 'archived' })
      : null;
    const writeInput: ProjectWriteInput = {
      id: existing.id,
      title: existing.title,
      source_id: existing.source_id,
      created_at: existing.created_at,
      state: 'archived',
      last_activity_at: existing.last_activity_at,
      sync_state: existing.sync_state,
      conflict_policy: existing.conflict_policy,
      related_contact_ids: existing.related_contact_ids,
    };
    if (existing.description !== undefined) writeInput.description = existing.description;
    if (existing.target_completion_at !== undefined) writeInput.target_completion_at = existing.target_completion_at;
    if (existing.parent_project_id !== undefined) writeInput.parent_project_id = existing.parent_project_id;
    if (existing.source_record_id !== undefined) writeInput.source_record_id = existing.source_record_id;
    if (existing.connection_id !== undefined) writeInput.connection_id = existing.connection_id;
    if (existing.source_record_hash !== undefined) writeInput.source_record_hash = existing.source_record_hash;
    if (existing.source_version_token !== undefined) writeInput.source_version_token = existing.source_version_token;
    if (existing.source_updated_at !== undefined) writeInput.source_updated_at = existing.source_updated_at;
    if (existing.source_extension_blob !== undefined) writeInput.source_extension_blob = existing.source_extension_blob;
    const project = deps.store.writeProject(writeInput, deps.now?.());
    // Archive is always a state transition (the early-return above
    // catches the no-op case), so both `updated` + `state_changed`
    // always fire.
    emitWorkEntityEvent(
      deps,
      'project',
      'updated',
      tagWorkEntity('project', project),
      tagWorkEntity('project', existing),
    );
    emitWorkEntityEvent(
      deps,
      'project',
      'state_changed',
      tagWorkEntity('project', project),
      tagWorkEntity('project', existing),
    );
    cascadeOnWrite(deps, 'project', project.id, 'update');
    if (route !== null && sourceReg !== null) {
      await dispatchVendorWrite(deps, sourceReg, 'project', route, {
        local_id: existing.id,
        prior: existing,
        current: project,
      });
      const refreshed = deps.store.readProject(existing.id);
      if (refreshed !== null) return { project: refreshed };
    }
    return { project };
  };

/** D-174 #22 — project delete (tombstone-by-default), the RPC-channel
 *  counterpart of `task-delete` / `note-delete`. Like `commitmentDelete`
 *  this has NO kernel slug (the 14 PA3 ingredients model project
 *  end-of-life as `project-archive`, a state transition, not a delete);
 *  it is reached only from the `work_entity.delete` pair-RPC so the Data
 *  back-office surface can remove a row the user owns. Emits the same
 *  `deleted` warehouse event + cascade as the task/note deletes. */
const projectDelete = (deps: WorkEntityIngredientDeps) =>
  async (input: { id: string; tombstone?: boolean }): Promise<{
    ok: true;
    id: string;
    tombstoned: boolean;
  }> => {
    const readThrough = resolveReadThroughWriteTarget(deps, 'project', input.id);
    if (readThrough !== null) {
      await dispatchReadThroughVendorWrite(deps, readThrough, 'project', 'delete', {});
      return { ok: true as const, id: input.id, tombstoned: false };
    }
    const localId = resolveWorkEntityInputId(deps, 'project', input.id);
    const existing = deps.store.readProject(localId);
    if (!existing) throw new WorkEntityNotFoundError('project', input.id);
    const tombstone = input.tombstone !== false;
    const sourceReg = deps.store.getSource(existing.source_id);
    // Vendor-first, like task-delete.
    if (sourceReg) {
      const route = await prepareVendorWrite(deps, sourceReg, 'project', 'delete', {});
      if (route !== null) {
        await dispatchVendorWrite(deps, sourceReg, 'project', route, {
          local_id: existing.id,
          prior: existing,
          current: existing,
        });
      }
    }
    const ok = deps.store.deleteProject(localId, { tombstone, ...(deps.now ? { now: deps.now() } : {}) });
    if (!ok) throw new WorkEntityNotFoundError('project', input.id);
    emitWorkEntityEvent(
      deps,
      'project',
      'deleted',
      tagWorkEntity('project', existing),
      tagWorkEntity('project', existing),
    );
    cascadeOnWrite(deps, 'project', existing.id, 'delete');
    return { ok: true as const, id: input.id, tombstoned: tombstone };
  };

// ────────────────────────────────────────────────────────────────
// Public composer
// ────────────────────────────────────────────────────────────────

/** Build the work-entity dispatcher slots.
 *
 *  The first 14 back the kernel CRUD ingredients (task-create /
 *  task-update / task-delete / task-mark-done + the note / commitment /
 *  project parallels) and are spread into the server runtime's
 *  `kernelDispatchers` alongside the shared / collection / annotation /
 *  etc. slots (excess keys are ignored by the kernel adapter, which
 *  routes only the slugs it knows). The last two — `commitmentDelete`
 *  + `projectDelete` (D-174 #22) — have NO kernel slug and are reached
 *  ONLY from the `work_entity.delete` pair-RPC; they live here so the
 *  delete path reuses the same `emitWorkEntityEvent` + cascade plumbing
 *  the task/note deletes use (one place owns warehouse-event emission).
 */
export const createWorkEntityDispatchers = (deps: WorkEntityIngredientDeps) => ({
  workEntityList: async (input: {
    kind: WorkEntityKind;
    source_id?: string;
    sync_states?: readonly import('@recued/contracts').SyncState[];
    include_deleted?: boolean;
    parent_project_id?: string;
    limit?: number;
    offset?: number;
  }) => {
    const query = {
      ...(input.source_id !== undefined ? { source_id: input.source_id } : {}),
      ...(input.sync_states !== undefined ? { sync_states: input.sync_states } : {}),
      ...(input.include_deleted !== undefined ? { include_deleted: input.include_deleted } : {}),
      ...(input.parent_project_id !== undefined
        ? {
            parent_project_id: resolveWorkEntityInputId(
              deps,
              'project',
              input.parent_project_id,
            ),
          }
        : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.offset !== undefined ? { offset: input.offset } : {}),
    };
    // This op reads the local canonical tables. A read_through Source keeps no
    // rows there, so scoping the list to one is a question this surface cannot
    // answer — and answering it with an empty list reads as "the Source has no
    // records". Refuse, and name the surface that fetches them.
    const readThrough = readThroughSourceIds(deps.store.listSources());
    if (input.source_id !== undefined && readThrough.has(input.source_id)) {
      throw new WorkEntityValidationError(
        `source_id '${input.source_id}' is read_through and materializes no local rows — `
          + "this generic list reads the canonical tables only. Use 'work.search' (or the "
          + "Source's own provider list operation), which invokes the Source on demand.",
        'source_id',
      );
    }
    // Defensive residue filter, matching `work.search`: the boot migration
    // purges rows when a Source flips to read_through, but an interrupted
    // migration must never serve rows the declaration says do not exist.
    const rows = deps.resolver.listByKind(input.kind, query);
    const entities = rows.filter((entity) => !readThrough.has(entity.source_id));
    // Keep `total` on the same basis as `entities`. The store count cannot
    // express the exclusion, so subtract what this page actually dropped —
    // exact in the normal case (no residue, nothing subtracted) and never
    // over-reporting more residue than was observed.
    const total = deps.store.countByKind(input.kind, query)
      - (rows.length - entities.length);
    return { entities, total };
  },
  workEntityGet: async (input: { kind: WorkEntityKind; id: string }) => {
    const entity = readWorkEntityInput(deps, input.kind, input.id);
    return { entity, found: entity !== null };
  },
  taskCreate: taskCreate(deps),
  taskUpdate: taskUpdate(deps),
  taskDelete: taskDelete(deps),
  taskMarkDone: taskMarkDone(deps),
  noteCreate: noteCreate(deps),
  noteUpdate: noteUpdate(deps),
  noteDelete: noteDelete(deps),
  commitmentCreate: commitmentCreate(deps),
  commitmentUpdate: commitmentUpdate(deps),
  commitmentFulfill: commitmentLifecycleMove(deps, 'fulfilled'),
  commitmentCancel: commitmentLifecycleMove(deps, 'cancelled'),
  projectCreate: projectCreate(deps),
  projectUpdate: projectUpdate(deps),
  projectArchive: projectArchive(deps),
  // D-210 — booking. RPC-only at 2a (no kernel slug yet): the direct
  // webclient CRUD path works, the recipe/AI op surface lands with the
  // kernel-op registration.
  bookingCreate: bookingCreate(deps),
  bookingUpdate: bookingUpdate(deps),
  bookingDelete: bookingDelete(deps),
  // D-174 #22 — RPC-only delete dispatchers (no kernel slug).
  commitmentDelete: commitmentDelete(deps),
  projectDelete: projectDelete(deps),
});
