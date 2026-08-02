/** D-192 read-resolution consumers — the work-entity read tool pair
 *  (`work.search` / `work.read`) behind the chat Tier-1 registry, which
 *  the mcp_wire adapter also serves to external agents.
 *
 *  FIRST consumer of the pure decision core
 *  (`work-entity-read-resolution.ts`) and of the P4b targeted-read
 *  executor:
 *
 *  - `work.search` — local rich meta is the DISCOVERY layer (spec
 *    § Read resolution policy). Results ride `source_freshness`
 *    verdicts + `long_text.fidelity` markers verbatim (a bounded
 *    preview is never presented as complete content). The `current` /
 *    `detail` flags run the wild-query planner
 *    (`planWorkEntityWildQueryReads`): bounded targeted vendor reads
 *    where declared, `narrow` (ask-to-narrow) over the caps — never
 *    unbounded remote fanout.
 *  - `work.read` — one record through `resolveWorkEntityReadPlan`:
 *    deterministic local for `rich_meta`, targeted remote for
 *    `remote_detail` (per the declared `remote_when`) and
 *    `current_remote` (always escalates — a warm mirror can be a full
 *    poll cycle stale). A failed escalation DEGRADES to the local row
 *    with an honest `escalation_error` — never a silent fallback, and
 *    never a loop-bait bare failure.
 *
 *  Escalated reads run through the SAME gated + audited invoke spine
 *  the sync runner and write executor use
 *  (`runWorkEntitySourceTargetedRead` → `runGatedCatalogOperation`),
 *  under a dedicated synthetic READ recipe identity — an AI-planned
 *  remote read is audited as a connection read, never hidden behind
 *  the local resolver (spec § Read resolution policy rule 6) — AND
 *  under the dispatching caller's `ExecutionSource` (threaded verbatim:
 *  the audit carries the real `(channel × actor × contract_id)` origin,
 *  and the catalog gateway's per-actor `contract.override` tightening
 *  applies exactly as it would to a recipe's gateway call under that
 *  source). A gateway `ask` verdict surfaces as a `policy` escalation
 *  error (fail-closed; this spine has no approval queue — the write
 *  executor's posture).
 *
 *  Escalated reads are SERVE-ONLY in v1: the vendor-current record is
 *  returned to the caller but never folded into the mirror. The sync
 *  cycle owns mirror state — a read-path writer would have to
 *  replicate the pending-write dirty guard (`listPendingWriteStates`)
 *  to avoid clobbering staged local edits, and a stale-until-next-poll
 *  mirror row is exactly what `source_freshness` already discloses.
 *
 *  Exposure axes (deliberately separate — see
 *  `feedback_separate_authorization_axes`):
 *  - `mcp_wire` (external doors): rows are filtered to Sources the
 *    owner flipped `mcp_exposed: true` (Settings → Work Entities;
 *    default OFF per the D-136 P7.E privacy posture — this module is
 *    the flag's first read-path consumer). The result's
 *    `hidden_sources` count keeps an empty page honest (the
 *    coverage-disclosure precedent from `recued_contactEngagementsList`).
 *  - owner chat: ungated — the owner's own AI reads the owner's
 *    warehouse, like every other Tier-1 read primitive.
 *  - the vendor escalation itself is gated by the connection gateway's
 *    policy matrix on EVERY channel, independent of the flag. */

import type {
  ChatDispatchContext,
  ChatDispatchResult,
  IngredientManifest,
  RecipeDefinition,
  SourceRegistration,
  WorkEntity,
  WorkEntityKind,
  WorkEntitySourceFreshness,
} from '@recued/contracts';
import {
  WORK_ENTITY_LIST_HYDRATION_MAX_ROWS_PER_CYCLE,
  parseQualifiedWorkEntityId,
  qualifyWorkEntityId,
  QualifiedWorkEntityIdError,
  WORK_ENTITY_KIND_SET,
  WORK_ENTITY_KINDS,
} from '@recued/contracts';

import { getByDotPath } from './source-mirror/fetch.js';
import { runGatedCatalogOperation } from './source-mirror/fetch.js';
import { resolveConfigArgBindings } from './work-entity-config-args.js';
import { resolvePersistDependencyListArgs } from './source-dependency-resolver.js';
import {
  classifyWorkEntitySourceFreshness,
  planWorkEntityWildQueryReads,
  resolveWorkEntityReadPlan,
  workEntityLongText,
  type WorkEntityLongText,
  type WorkEntityReadFidelity,
  type WorkEntityReadPlan,
  type WildQuerySourceInput,
} from './work-entity-read-resolution.js';
import {
  prepareWorkEntitySourceTargetedRead,
  runWorkEntitySourceTargetedRead,
  type WorkEntityTargetedReadDeps,
  type WorkEntityTargetedReadPrepared,
} from './work-entity-write-executor.js';
import {
  admitSourceCatalogEscalation,
  escalationOrigin,
  type EscalationOrigin,
} from './escalation-admission.js';
import {
  collectionReadFencedHint,
  workEntityReadVerbOpFencedHint,
} from './read-grant-checker.js';
import type { OpAdmissionGate } from './op-admission-gate.js';
import {
  projectWorkEntitySourceRow,
  type ProjectedWorkEntityUpsert,
} from './work-entity-source-projector.js';
import type { KernelWorkEntitySourceDeclaration } from './work-entity-source-boot.js';
import {
  WorkEntityResolverError,
  type WorkEntityResolver,
} from './work-entity-resolver.js';

// ────────────────────────────────────────────────────────────────
// Deps + synthetic audit identity
// ────────────────────────────────────────────────────────────────

export interface WorkEntityReadToolsDeps {
  /** D-205 #3 — the `data.<collection>` READ FENCE for the work-entity kind being read
   *  (`task` / `note` / `commitment` / `project` are all `READABLE_COLLECTIONS`, and the
   *  tool's own `kind` arg IS the collection — so the fence is exactly `kind`).
   *
   *  ⚠ **REQUIRED on purpose, not optional.** These tools read the owner's work graph and
   *  had NO collection fence at all: a door whose owner had revoked `note` in the grants
   *  panel still read every note. A fence that can be silently left unwired is precisely
   *  how this family produced six "built and wired to nothing" clusters — so a work-entity
   *  read tool cannot be CONSTRUCTED without deciding its read fence. (Same discipline as
   *  D-205 #1's `syncState`: a sync task cannot exist without somewhere to report health.)
   *
   *  Injected by `chat-tool-handlers.ts` (`isCollectionReadGrantedForDispatch`) — the
   *  predicate, not the resolver, so the gate logic stays in ONE place and this module
   *  does not grow a grant-store dependency. */
  isCollectionReadGranted: (
    collection: WorkEntityKind,
    ctx: ChatDispatchContext,
  ) => boolean;
  /** The `core.work-entity.read` VERB-OP fence — "may this caller use these
   *  tools at all", the axis ORTHOGONAL to the per-kind collection fence above.
   *  Composed AND with it (`isGrantedReadAdmissible`'s rule: a collection grant
   *  does NOT imply the verb).
   *
   *  Until this existed the read half of `work-entity` had NO grant handle while
   *  all 15 of its writes had one — so the tools were default-ON for any door
   *  (Tier-1 + `classification: 'read'` → `buildDefaultMcpInboundTokenGrants` =
   *  true), and the only thing between a door and the whole work graph was the
   *  per-Source `mcp_exposed` flag, which is GLOBAL rather than per-door.
   *
   *  ⚠ **REQUIRED on purpose, not optional** — the same discipline as
   *  `isCollectionReadGranted` above: a fence that can be silently left unwired
   *  is how this family produced its "built and wired to nothing" clusters, and
   *  an OPTIONAL verb fence would have exactly the shape of the bug that made
   *  this op necessary. A work-entity read tool cannot be CONSTRUCTED without
   *  deciding it.
   *
   *  Injected by `chat-tool-handlers.ts` (`admitWorkEntityRead`) — the
   *  predicate, not the gate, so the admission logic stays in ONE place beside
   *  its `memory.*` peers and this module grows no grant-store dependency. */
  isVerbOpGranted: (ctx: ChatDispatchContext) => boolean;
  /** Late-bound like every chat-tool store getter — resolves at
   *  dispatch time; undefined surfaces `execution_error` (dbless
   *  harness parity). */
  getResolver: () => WorkEntityResolver | undefined;
  /** The targeted-read spine (gateway fetch deps + the declaration
   *  resolver the sync/write wires share). Undefined until the
   *  post-listener runtime populates it — escalation then degrades to
   *  the honest local answer. */
  getTargetedReadDeps: () => WorkEntityTargetedReadDeps | undefined;
  /** D-188 + the admission seam — the op-admission gate
   *  (`isFrozenByPause` + `isOpGranted`, late-bound off execute deps).
   *  The gated invoke spine never traverses the op-admission gate, so a
   *  caller-triggered escalation must consult BOTH halves here: the
   *  master pause (a paused server halts contracted + AI operations)
   *  and the unified grant store's op axis (an explicit revoke on the
   *  governing contract — owner or door — blocks the vendor read).
   *  Absent (dbless / unit) ⇒ pause + op grants unenforced for OWNER
   *  chat (the admission gate's own degradation posture) and external
   *  escalation REFUSED outright (a door's admission cannot run
   *  without the gate — fail closed, matching the pre-seam posture). */
  getOpAdmissionGate?: () =>
    | Pick<OpAdmissionGate, 'isFrozenByPause' | 'isOpGranted'>
    | undefined;
  now?: () => number;
}

/** Synthetic recipe identity for the scoped gateway ctx — targeted
 *  reads the READ TOOLS trigger audit under `work-entity-source-read`
 *  (step `targeted_read`), distinct from the write path's
 *  `work-entity-source-write` preflight/verify reads. Never installed,
 *  never executed as a recipe. */
const SOURCE_READ_RECIPE: RecipeDefinition = {
  recipe_id: 'work-entity-source-read',
  version: 1,
  ttl: 0,
  metadata: {
    name: 'Work-entity Source read',
    description:
      'Synthetic identity for D-192 read-resolution targeted vendor reads '
      + '(chat/MCP work-entity read tools). Not an installable recipe.',
    author: 'recued',
    supported_platforms: [],
  },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { render: [] },
};

const TARGETED_READ_STEP_ID = 'targeted_read';

/** The `ExecutionSource` producers populate the dispatch ctx on both
 *  channels (owner chat via `buildChatExecutionSource`, the wire via
 *  mcp-server), and the targeted-read spine threads it VERBATIM into
 *  the gated invoke (honest audit attribution + the catalog gateway's
 *  per-actor `contract.override` tightening; a gateway `ask` stays a
 *  fail-closed `policy` outcome — no approval queue on this spine).
 *
 *  THE ADMISSION SEAM (lifts the former unconditional external
 *  refusal): every escalation now runs the SAME per-dispatch admission
 *  a door's own raw-op `task.read` runs —
 *  `admitCatalogOpForSource` = `evaluatePreflightAdmission` (the
 *  snapshot's `allowed_tools` + `scope_restrictions` + the op-risk
 *  probe) + the D-188 pause freeze + `opAdmissionGate.isOpGranted` on
 *  the declared `operation_id`. One shared core (raw-op-dispatch.ts) +
 *  one shared channel posture (`escalation-admission.ts`, since the
 *  CRM S3 leg joined), no drift. Deliberate difference from the raw-op
 *  caller: NO catalog-slug aliasing into `allowed_tools` — a
 *  `work.search`/`work.read` wire grant is a MIRROR-read grant, not a
 *  reach-the-vendor grant, so a door escalates only when its contract
 *  already allows the backing catalog tool. Owner chat runs the same
 *  core snapshot-less (contract-free source → reads admit under the
 *  owner ceiling; pause + an explicit owner-contract op revoke still
 *  gate — closing the carried owner-chat `isOpGranted` gap).
 *
 *  Fail-closed residue: an external dispatch with no threaded
 *  source/snapshot (producer gap) or no admission gate (dbless) stays
 *  refused outright — admission that cannot run never admits. */
const EXTERNAL_ESCALATION_UNEVALUABLE =
  'vendor escalation from an external MCP channel could not be evaluated '
  + "under the door's contract (no dispatch identity/contract snapshot/"
  + 'admission gate on this path) — refused fail-closed (server policy, not '
  + 'a transient failure; do not retry). The local mirror row is served; '
  + 'see source_freshness.';

/** The internal-channel sibling of the refusal above: a dispatch
 *  identity carrying a contract_id arrived WITHOUT its paired contract
 *  snapshot (a producer gap — `evaluatePreflightAdmission` throws on
 *  it by design; refuse honestly instead). */
const CONTRACTED_ESCALATION_UNEVALUABLE =
  'the dispatch identity carries a contract but no contract snapshot rode '
  + 'the dispatch, so the vendor read could not be evaluated under it — '
  + 'refused fail-closed (a server-side producer gap, not a transient '
  + 'failure; do not retry). The local mirror row is served; see '
  + 'source_freshness.';

/** Approval-class verdicts cannot HOLD on this serve-only read spine
 *  (no recipe/run to checkpoint) — surface the honest non-retryable
 *  refusal instead of a silent fail or a dangling ask. */
const escalationRequiresApproval = (detail: string): string =>
  `the vendor read requires approval under the active contract policy (${detail}) `
  + 'and this read path cannot hold for approval — the local mirror row is '
  + 'served (see source_freshness). Ask the owner to raise this door\'s trust '
  + 'or grant the operation; do not retry.';

/** A structural admission deny — name the code + detail + the owner
 *  control so the model relays a fixable fact instead of retrying. */
const escalationDenied = (code: string | undefined, detail: string | undefined): string =>
  `the vendor read is denied by the active contract policy `
  + `(${code ?? 'denied'}: ${detail ?? 'no detail'}) — the local mirror row is `
  + 'served (see source_freshness). Server policy, not a transient failure; '
  + 'ask the owner to grant the backing catalog tool / operation on this '
  + 'door; do not retry.';

/** D-188 — the pause refusal, aligned with the canonical `server_paused`
 *  admission detail so the model reads pause as pause (never a grant or
 *  network problem). Leads with the transient truth + the resume cue. */
const SERVER_PAUSED_ESCALATION =
  'server is paused — contracted and AI operations are halted until the owner '
  + 'resumes, so the vendor read was not attempted (not a grant problem; do '
  + 'not retry until resumed). The local mirror row is served; see '
  + 'source_freshness.';

type EscalationAdmission =
  | { admitted: true }
  | { admitted: false; reason: string };

/** THE ADMISSION SEAM — run the shared per-dispatch catalog-op
 *  admission (`admitSourceCatalogEscalation` → `admitCatalogOpForSource`:
 *  preflight probe + pause + op-grant, see the module note above) for
 *  one prepared escalation. The channel posture (mcp_wire fail-closed
 *  without source/snapshot/gate; owner chat snapshot-less; the
 *  contracted-without-snapshot honest refusal) lives in the shared
 *  `escalation-admission.ts` module — one home with the CRM S3 leg —
 *  and this mapper only renders each typed refusal as THIS family's
 *  model-facing copy. Verdict mapping: `admit` proceeds;
 *  `server_paused` keeps the canonical D-188 wording (pause must never
 *  read as a grant problem); any other deny/ask is a named,
 *  non-retryable policy refusal. */
const admitEscalation = (
  deps: WorkEntityReadToolsDeps,
  ctx: ChatDispatchContext,
  prepared: {
    catalogSlug: string;
    manifest: IngredientManifest;
    operation: string;
  },
): EscalationAdmission => {
  const admission = admitSourceCatalogEscalation(deps.getOpAdmissionGate?.(), ctx, {
    catalogSlug: prepared.catalogSlug,
    manifest: prepared.manifest,
    operation: prepared.operation,
  });
  if (admission.admitted) return { admitted: true };
  const refusal = admission.refusal;
  switch (refusal.kind) {
    case 'external_unevaluable':
      return { admitted: false, reason: EXTERNAL_ESCALATION_UNEVALUABLE };
    case 'contracted_unevaluable':
      return { admitted: false, reason: CONTRACTED_ESCALATION_UNEVALUABLE };
    case 'server_paused':
      return { admitted: false, reason: SERVER_PAUSED_ESCALATION };
    case 'requires_approval':
      return { admitted: false, reason: escalationRequiresApproval(refusal.detail) };
    case 'denied':
      return { admitted: false, reason: escalationDenied(refusal.code, refusal.detail) };
  }
};

// ────────────────────────────────────────────────────────────────
// Result shapes (model-facing)
// ────────────────────────────────────────────────────────────────

/** One work item as the agent sees it — the lean rich-meta projection.
 *  `long_text.fidelity` rides VERBATIM from the fidelity-honoring
 *  accessor: 'preview' text is a bounded excerpt, never the complete
 *  body. */
export interface WorkEntityToolItem {
  /** Versioned Source-qualified id. Pass it unchanged to `work.read` or the
   *  matching provider operation. A generic `data.<kind>` mutation can also
   *  consume it when a local mirrored row exists; read-through rows have no
   *  local mutation target. */
  id: string;
  kind: WorkEntityKind;
  source_id: string;
  updated_at: number;
  title?: string;
  // task
  done?: boolean;
  state?: string;
  progress?: number;
  due_at?: number;
  priority?: string;
  completed_at?: number;
  // project
  target_completion_at?: number;
  // commitment
  direction?: string;
  lifecycle_state?: string;
  due_status?: string;
  promised_at?: number;
  promised_for_at?: number;
  // booking — `lifecycle_state` is shared with commitment above. The
  // booking's WHEN is its OWN (D-210 A.2): booking and calendar are
  // disjoint, so the model is handed the slot itself rather than a
  // pointer to an event holding it. Emitted as a pair or not at all.
  slot_start_at?: number;
  slot_end_at?: number;
  monetary_amount?: string;
  monetary_currency?: string;
  counterparty_contact_id?: string;
  long_text?: WorkEntityLongText & { truncated?: boolean };
  /** Present when this row's canonical fields were refreshed by a live
   *  vendor read within THIS call (wild-query escalation). */
  live?: true;
}

export interface WorkEntityEscalationError {
  source_id: string;
  kind: 'config' | 'policy' | 'error' | 'unavailable' | 'projection';
  reason: string;
}

/** In LIST results the long text is clamped to keep the tool result
 *  bounded; `truncated: true` + the row's own fidelity marker tell the
 *  agent to `work.read` for the full text. */
const LIST_LONG_TEXT_CLAMP = 280;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
/** The store's own list ceiling — the in-handler filter scans at most
 *  this many rows per call (matches `MAX_LIST_LIMIT`). */
const DISCOVERY_SCAN_CAP = 1000;

// ────────────────────────────────────────────────────────────────
// Small helpers (mirror chat-tool-handlers' local conventions)
// ────────────────────────────────────────────────────────────────

const asObject = (raw: unknown): Record<string, unknown> | null => {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
};

const invalidArgs = (detail: string): ChatDispatchResult => ({
  ok: false,
  reason: 'invalid_args',
  detail,
});

const executionError = (detail: string): ChatDispatchResult => ({
  ok: false,
  reason: 'execution_error',
  detail,
});

const errMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

const isWorkEntityKind = (v: unknown): v is WorkEntityKind =>
  typeof v === 'string' && WORK_ENTITY_KIND_SET.has(v as WorkEntityKind);

const clampLimit = (v: unknown): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : DEFAULT_LIMIT;
  return Math.min(Math.max(n, 1), MAX_LIMIT);
};

/** The external-door reject for a query scoped to a non-exposed
 *  Source. Source EXISTENCE is Settings-level metadata (ids surface in
 *  every search's freshness array), so naming the control here is
 *  honest + actionable — unlike row existence, which `work.read`
 *  deliberately does NOT disclose for hidden Sources. */
const notExposedRejection = (source_id: string): ChatDispatchResult => ({
  ok: false,
  reason: 'classification_blocked',
  detail:
    `source '${source_id}' is not MCP-exposed — the owner opts a work Source `
    + 'in via Settings → Work Entities (read rejected)',
});

// ────────────────────────────────────────────────────────────────
// Lean projection
// ────────────────────────────────────────────────────────────────

const projectItem = (
  entity: WorkEntity,
  opts: { clampLongText: boolean },
): WorkEntityToolItem => {
  const item: WorkEntityToolItem = {
    id: entity.id,
    kind: entity._kind,
    source_id: entity.source_id,
    updated_at: entity.updated_at,
  };
  switch (entity._kind) {
    case 'task':
      item.title = entity.title;
      item.done = entity.done;
      if (entity.state !== undefined) item.state = entity.state;
      if (entity.progress !== undefined) item.progress = entity.progress;
      if (entity.due_at !== undefined) item.due_at = entity.due_at;
      if (entity.priority !== undefined) item.priority = entity.priority;
      if (entity.completed_at !== undefined) item.completed_at = entity.completed_at;
      break;
    case 'project':
      item.title = entity.title;
      item.state = entity.state;
      if (entity.target_completion_at !== undefined) {
        item.target_completion_at = entity.target_completion_at;
      }
      break;
    case 'note':
      if (entity.title !== undefined) item.title = entity.title;
      break;
    case 'commitment':
      item.direction = entity.direction;
      item.lifecycle_state = entity.lifecycle_state;
      item.due_status = entity.due_status;
      item.promised_at = entity.promised_at;
      if (entity.promised_for_at !== undefined) {
        item.promised_for_at = entity.promised_for_at;
      }
      break;
    case 'booking':
      item.title = entity.title;
      item.lifecycle_state = entity.lifecycle_state;
      if (entity.monetary_value !== undefined) {
        item.monetary_amount = entity.monetary_value.amount;
        item.monetary_currency = entity.monetary_value.currency;
      }
      if (entity.counterparty_contact_id !== undefined) {
        item.counterparty_contact_id = entity.counterparty_contact_id;
      }
      // The TIME ITSELF (D-210 A.2), as a pair. An absent pair means "no
      // time agreed yet", never "lookup failed" — an un-timed booking is a
      // real state, so the model must not read absence as an error.
      if (entity.slot_start_at !== undefined && entity.slot_end_at !== undefined) {
        item.slot_start_at = entity.slot_start_at;
        item.slot_end_at = entity.slot_end_at;
      }
      break;
  }
  const long = workEntityLongText(entity);
  if (long !== null) {
    if (opts.clampLongText && long.text.length > LIST_LONG_TEXT_CLAMP) {
      item.long_text = {
        field: long.field,
        text: long.text.slice(0, LIST_LONG_TEXT_CLAMP),
        fidelity: long.fidelity,
        truncated: true,
      };
    } else {
      item.long_text = long;
    }
  }
  return item;
};

const qualifiedIdForEntity = (entity: WorkEntity): string =>
  qualifyWorkEntityId({
    kind: entity._kind,
    source_id: entity.source_id,
    ...(entity.source_record_id !== undefined
      ? { source_record_id: entity.source_record_id }
      : {}),
    local_id: entity.id,
  });

const qualifyItem = (
  entity: WorkEntity,
  item: WorkEntityToolItem,
): WorkEntityToolItem => ({
  ...item,
  id: qualifiedIdForEntity(entity),
});

/** Overlay the vendor-current projection onto a lean item. Only the
 *  kind's DECLARED-projectable canonical fields overlay (defined
 *  values win); canonical long-body columns are never overlaid — the
 *  projector's local-only posture (`body: ''` sentinel on note) holds
 *  here too, and the live long text arrives separately from the raw
 *  record's preview paths at FULL fidelity. */
const overlayLive = (
  item: WorkEntityToolItem,
  projected: ProjectedWorkEntityUpsert,
  liveLong: WorkEntityLongText | null,
): WorkEntityToolItem => {
  const out: WorkEntityToolItem = { ...item, live: true };
  switch (projected.kind) {
    case 'task': {
      const w = projected.write;
      if (w.title !== undefined) out.title = w.title;
      if (w.done !== undefined) out.done = w.done;
      if (w.state !== undefined) out.state = w.state;
      if (w.priority !== undefined) out.priority = w.priority;
      if (w.due_at !== undefined) out.due_at = w.due_at;
      if (w.progress !== undefined) out.progress = w.progress;
      if (w.completed_at !== undefined) out.completed_at = w.completed_at;
      break;
    }
    case 'project': {
      const w = projected.write;
      if (w.title !== undefined) out.title = w.title;
      if (w.state !== undefined) out.state = w.state;
      if (w.target_completion_at !== undefined) {
        out.target_completion_at = w.target_completion_at;
      }
      break;
    }
    case 'note': {
      const w = projected.write;
      if (w.title !== undefined) out.title = w.title;
      break;
    }
    default: {
      // Adding a declarable Source kind must also implement its live-read
      // overlay. Never silently inherit note/project semantics.
      const exhaustive: never = projected;
      return exhaustive;
    }
  }
  if (liveLong !== null) out.long_text = liveLong;
  return out;
};

/** Ceiling on live-read long text. A tool result feeds the next model
 *  turn whole (`chat-turn-executor` carries the full payload), so a
 *  multi-MB vendor body must clamp — with `truncated: true`, never
 *  silently (codex MEDIUM). Generous enough for real task/note bodies. */
const LIVE_LONG_TEXT_CAP = 16_000;

/** Extract the record's long text from the declaration's preview
 *  paths — a targeted read serves the raw field the projection would
 *  clamp, which is the point of the `remote_detail` escalation. First
 *  declared preview field with a non-empty string wins (declaration
 *  order, matching the local accessor's preview-lane precedence).
 *
 *  Fidelity is DECLARATION-DRIVEN (codex MEDIUM): 'complete' only when
 *  the author declared `complete_body_required` in `remote_when` —
 *  that is the Source's claim that the remote read serves complete
 *  bodies. Without it the mapped vendor field may itself be an excerpt
 *  (`body_preview`-shaped), so the marker stays the honest 'preview'
 *  floor. */
const extractLiveLongText = (
  declaration: KernelWorkEntitySourceDeclaration,
  raw: Record<string, unknown>,
): (WorkEntityLongText & { truncated?: boolean }) | null => {
  const preview = declaration.projection.preview;
  if (preview === undefined) return null;
  const declaresCompleteBody =
    declaration.read_resolution?.remote_when?.includes('complete_body_required') ?? false;
  for (const [field, spec] of Object.entries(preview)) {
    const value = getByDotPath(raw, spec.field);
    if (typeof value === 'string' && value.length > 0) {
      const fidelity = declaresCompleteBody ? 'complete' as const : 'preview' as const;
      if (value.length > LIVE_LONG_TEXT_CAP) {
        return { field, text: value.slice(0, LIVE_LONG_TEXT_CAP), fidelity, truncated: true };
      }
      return { field, text: value, fidelity };
    }
  }
  return null;
};

// ────────────────────────────────────────────────────────────────
// Shared per-source description (policy + read-op presence)
// ────────────────────────────────────────────────────────────────

const describeSource = (
  targeted: WorkEntityTargetedReadDeps | undefined,
  source_id: string,
): {
  declaration: KernelWorkEntitySourceDeclaration | null;
  policy: KernelWorkEntitySourceDeclaration['read_resolution'] | null;
  has_read_op: boolean;
} => {
  const resolved = targeted?.resolveDeclaration(source_id) ?? null;
  if (resolved === null) return { declaration: null, policy: null, has_read_op: false };
  const { declaration } = resolved;
  const readOp = declaration.ops.read;
  return {
    declaration,
    policy: declaration.read_resolution ?? null,
    has_read_op: typeof readOp === 'string' && readOp.length > 0,
  };
};

/** Run one targeted read + projection for a mirror row. */
const readLive = async (
  targeted: WorkEntityTargetedReadDeps,
  prepared: WorkEntityTargetedReadPrepared,
  source_record_id: string,
  origin: EscalationOrigin,
): Promise<
  | { ok: true; projected: ProjectedWorkEntityUpsert | null; long: WorkEntityLongText | null }
  | { ok: false; kind: WorkEntityEscalationError['kind']; reason: string }
> => {
  const outcome = await runWorkEntitySourceTargetedRead(targeted, {
    prepared,
    source_record_id,
    stepId: TARGETED_READ_STEP_ID,
    auditRecipe: SOURCE_READ_RECIPE,
    ...origin,
  });
  if (!outcome.ok) return outcome;
  // The record must BE the targeted record before anything projects
  // from it (codex HIGH — the write path's read-before-write guard,
  // mirrored): catalog/vendor drift returning a different record would
  // otherwise overlay another record's fields onto this row and serve
  // them as `live: true`.
  const readId = getByDotPath(outcome.record, prepared.declaration.remote.id);
  const readKey =
    typeof readId === 'string' ? readId : typeof readId === 'number' ? String(readId) : '';
  if (readKey !== source_record_id) {
    return {
      ok: false,
      kind: 'error',
      reason:
        `targeted read returned record '${readKey.length > 0 ? readKey : '<no id>'}'`
        + ` — expected '${source_record_id}' (catalog '${prepared.readOp.opKey}' drift?)`,
    };
  }
  const long = extractLiveLongText(prepared.declaration, outcome.record);
  const projected = projectWorkEntitySourceRow({
    declaration: prepared.declaration,
    source_id: prepared.source_id,
    connection_name: prepared.connection_name,
    source_record_id,
    raw: outcome.record,
  });
  if (!projected.ok) {
    // The record arrived but does not project (vendor shape drift /
    // over-cap canonical). The complete long text — the usual reason
    // for escalating — may still have extracted; serve what is honest.
    return long !== null
      ? { ok: true, projected: null, long }
      : { ok: false, kind: 'projection', reason: projected.reason };
  }
  return { ok: true, projected: projected.upsert, long };
};

// ────────────────────────────────────────────────────────────────
// work.search
// ────────────────────────────────────────────────────────────────

const projectedPreviewLongText = (
  projected: ProjectedWorkEntityUpsert,
): WorkEntityLongText | null => {
  const blob = projected.write.source_extension_blob;
  if (blob === undefined || blob === null || typeof blob !== 'object' || Array.isArray(blob)) {
    return null;
  }
  const preview = blob.preview;
  if (preview === undefined || preview === null || typeof preview !== 'object' || Array.isArray(preview)) {
    return null;
  }
  for (const [field, value] of Object.entries(preview as Record<string, unknown>)) {
    if (typeof value === 'string' && value.length > 0) {
      return { field, text: value, fidelity: 'preview' };
    }
  }
  return null;
};

const clampListLongText = (
  value: WorkEntityLongText | null,
): (WorkEntityLongText & { truncated?: boolean }) | null => {
  if (value === null || value.text.length <= LIST_LONG_TEXT_CLAMP) return value;
  return { ...value, text: value.text.slice(0, LIST_LONG_TEXT_CLAMP), truncated: true };
};

/** Project a vendor response directly to the public tool shape. No store write,
 *  local id, sync state, or warehouse event exists on this path. */
const projectReadThroughItem = (
  projected: ProjectedWorkEntityUpsert,
  now: number,
  opts: { clampLongText: boolean; longOverride?: WorkEntityLongText | null },
): WorkEntityToolItem => {
  const write = projected.write;
  const item: WorkEntityToolItem = {
    id: qualifyWorkEntityId({
      kind: projected.kind,
      source_id: write.source_id,
      source_record_id: write.source_record_id,
      local_id: write.source_record_id,
    }),
    kind: projected.kind,
    source_id: write.source_id,
    updated_at: write.source_updated_at ?? now,
    live: true,
  };
  switch (projected.kind) {
    case 'task': {
      const task = projected.write;
      item.title = task.title;
      item.done = task.done ?? false;
      if (task.state !== undefined) item.state = task.state;
      if (task.progress !== undefined) item.progress = task.progress;
      if (task.due_at !== undefined) item.due_at = task.due_at;
      if (task.priority !== undefined) item.priority = task.priority;
      if (task.completed_at !== undefined) item.completed_at = task.completed_at;
      break;
    }
    case 'project': {
      const project = projected.write;
      item.title = project.title;
      item.state = project.state ?? 'active';
      if (project.target_completion_at !== undefined) {
        item.target_completion_at = project.target_completion_at;
      }
      break;
    }
    case 'note':
      if (projected.write.title !== undefined) item.title = projected.write.title;
      break;
    default: {
      // Read-through is a first-class landing posture. A new kind is not
      // complete until its public transient projection is explicit here.
      const exhaustive: never = projected;
      return exhaustive;
    }
  }
  const long = opts.longOverride === undefined
    ? projectedPreviewLongText(projected)
    : opts.longOverride ?? projectedPreviewLongText(projected);
  const bounded = opts.clampLongText ? clampListLongText(long) : long;
  if (bounded !== null) item.long_text = bounded;
  return item;
};

interface ReadThroughListPrepared {
  source_id: string;
  connection_name: string;
  declaration: KernelWorkEntitySourceDeclaration;
  manifest: IngredientManifest;
  catalogSlug: string;
  operation: string;
  resultPath: string;
  args: Record<string, unknown>;
}

const prepareReadThroughList = (
  targeted: WorkEntityTargetedReadDeps,
  source_id: string,
):
  | { ok: true; prepared: ReadThroughListPrepared }
  | { ok: false; kind: 'config'; reason: string } => {
  const fail = (reason: string) => ({ ok: false as const, kind: 'config' as const, reason });
  const resolved = targeted.resolveDeclaration(source_id);
  if (resolved === null) return fail(`source '${source_id}' has no work-entity Source declaration`);
  const { declaration, connection_name, connection_config } = resolved;
  if (declaration.sync.posture !== 'read_through') {
    return fail(`source '${source_id}' is not declared read_through`);
  }
  const profile = targeted.fetchDeps.profiles.get(connection_name);
  if (profile === null) {
    return fail(`connection '${connection_name}' has no operation profile (not enrolled?)`);
  }
  const catalogSlug = profile.catalog_slug;
  if (catalogSlug === undefined || catalogSlug.length === 0) {
    return fail(`connection '${connection_name}' carries no catalog binding`);
  }
  const manifest = targeted.fetchDeps.executorConfig.manifests.get(catalogSlug) ?? null;
  if (manifest === null) return fail(`catalog manifest '${catalogSlug}' is not installed`);
  const operation = declaration.ops.list;
  if (operation === undefined || operation === null || operation.length === 0) {
    return fail(`source '${source_id}' declares no list operation`);
  }
  const opRow = manifest.operations?.[operation];
  if (opRow === undefined) return fail(`catalog '${catalogSlug}' declares no '${operation}' operation`);
  if (opRow.risk_tier !== 'read') {
    return fail(`declaration list op '${operation}' is '${opRow.risk_tier}', not read-tier`);
  }
  const resultPath = opRow.result_path ?? manifest.surfaces?.api?.result_path;
  if (resultPath === undefined || resultPath.length === 0) {
    return fail(`catalog '${catalogSlug}' declares no result_path for '${operation}'`);
  }
  const configArgs = resolveConfigArgBindings(
    declaration.op_arg_bindings?.list,
    connection_config,
  );
  if (!configArgs.ok) {
    return fail(
      `list operation needs arg '${configArgs.arg}' from connection config `
      + `'${configArgs.config_key}', which is unset`,
    );
  }
  const hasPersistListDependency = (declaration.source_dependencies ?? []).some(
    (dependency) =>
      dependency.resolve === 'persist'
      && dependency.binds.some((binding) => binding.op === 'list'),
  );
  let dependencyArgs: Record<string, unknown> = {};
  if (hasPersistListDependency) {
    if (targeted.dependencyStore === undefined) {
      return fail('a persist list dependency is declared but no dependency selection store is wired');
    }
    const resolvedDependencies = resolvePersistDependencyListArgs(
      targeted.dependencyStore,
      source_id,
      declaration,
    );
    if (!resolvedDependencies.ok) return fail(resolvedDependencies.reason);
    dependencyArgs = resolvedDependencies.listArgs;
  }
  return {
    ok: true,
    prepared: {
      source_id,
      connection_name,
      declaration,
      manifest,
      catalogSlug,
      operation,
      resultPath,
      args: { ...configArgs.args, ...dependencyArgs },
    },
  };
};

type ReadThroughListOutcome =
  | { ok: true; items: WorkEntityToolItem[]; truncated: boolean; row_error?: string }
  | { ok: false; kind: WorkEntityEscalationError['kind']; reason: string };

const runReadThroughList = async (
  deps: WorkEntityReadToolsDeps,
  targeted: WorkEntityTargetedReadDeps,
  source: SourceRegistration,
  ctx: ChatDispatchContext,
  now: number,
): Promise<ReadThroughListOutcome> => {
  const prepared = prepareReadThroughList(targeted, source.id);
  if (!prepared.ok) return prepared;
  const p = prepared.prepared;
  const admission = admitEscalation(deps, ctx, {
    catalogSlug: p.catalogSlug,
    manifest: p.manifest,
    operation: p.operation,
  });
  if (!admission.admitted) return { ok: false, kind: 'policy', reason: admission.reason };
  const origin = escalationOrigin(ctx);
  const run = targeted.runOperation ?? runGatedCatalogOperation;
  const invoked = await run(targeted.fetchDeps, {
    connection_name: p.connection_name,
    manifest: p.manifest,
    catalogSlug: p.catalogSlug,
    operationKey: p.operation,
    args: p.args,
    auditRecipe: SOURCE_READ_RECIPE,
    stepId: 'source_list',
    askReason: 'an on-demand Source read has no approval queue; grant the read operation first',
    ...origin,
  });
  if (!invoked.ok) return invoked;
  const rawRows = getByDotPath(invoked.raw, `result.${p.resultPath}`);
  if (!Array.isArray(rawRows)) {
    return {
      ok: false,
      kind: 'error',
      reason: `'${p.operation}' returned no record array at 'result.${p.resultPath}'`,
    };
  }
  const declaredCap = p.declaration.read_resolution.wild_query.max_remote_records;
  const cap = p.declaration.sync.list_rows === 'reference'
    ? Math.min(declaredCap, WORK_ENTITY_LIST_HYDRATION_MAX_ROWS_PER_CYCLE)
    : declaredCap;
  const rows = rawRows.slice(0, cap);
  const truncated = rawRows.length > cap || invoked.audit?.truncated === true;

  let hydration: WorkEntityTargetedReadPrepared | null = null;
  if (p.declaration.sync.list_rows === 'reference') {
    const readPrepared = prepareWorkEntitySourceTargetedRead(targeted, { source_id: source.id });
    if (!readPrepared.ok) return readPrepared;
    const readAdmission = admitEscalation(deps, ctx, {
      catalogSlug: readPrepared.prepared.catalogSlug,
      manifest: readPrepared.prepared.manifest,
      operation: readPrepared.prepared.readOp.opKey,
    });
    if (!readAdmission.admitted) {
      return { ok: false, kind: 'policy', reason: readAdmission.reason };
    }
    hydration = readPrepared.prepared;
  }

  const items: WorkEntityToolItem[] = [];
  let rowError: string | undefined;
  for (const listed of rows) {
    if (listed === null || typeof listed !== 'object' || Array.isArray(listed)) {
      rowError ??= 'list response contains a non-record row';
      continue;
    }
    const listedRecord = listed as Record<string, unknown>;
    const rawId = getByDotPath(listedRecord, p.declaration.remote.id);
    const source_record_id = typeof rawId === 'string'
      ? rawId
      : typeof rawId === 'number' ? String(rawId) : '';
    if (source_record_id.length === 0) {
      rowError ??= `a list row carries no id at '${p.declaration.remote.id}'`;
      continue;
    }
    let record = listedRecord;
    if (hydration !== null) {
      const hydrated = await runWorkEntitySourceTargetedRead(targeted, {
        prepared: hydration,
        source_record_id,
        stepId: TARGETED_READ_STEP_ID,
        auditRecipe: SOURCE_READ_RECIPE,
        ...origin,
      });
      if (!hydrated.ok) {
        rowError ??= hydrated.reason;
        continue;
      }
      const hydratedId = getByDotPath(hydrated.record, p.declaration.remote.id);
      const hydratedKey = typeof hydratedId === 'string'
        ? hydratedId
        : typeof hydratedId === 'number' ? String(hydratedId) : '';
      if (hydratedKey !== source_record_id) {
        rowError ??= `targeted hydration returned '${hydratedKey || '<no id>'}', expected '${source_record_id}'`;
        continue;
      }
      record = hydrated.record;
    }
    const projected = projectWorkEntitySourceRow({
      declaration: p.declaration,
      source_id: source.id,
      connection_name: p.connection_name,
      source_record_id,
      raw: record,
    });
    if (!projected.ok) {
      rowError ??= projected.reason;
      continue;
    }
    items.push(projectReadThroughItem(projected.upsert, now, { clampLongText: true }));
  }
  return {
    ok: true,
    items,
    truncated,
    ...(rowError !== undefined ? { row_error: rowError } : {}),
  };
};

export const runWorkEntitySearchTool = async (
  deps: WorkEntityReadToolsDeps,
  rawArgs: unknown,
  ctx: ChatDispatchContext,
): Promise<ChatDispatchResult> => {
  const args = asObject(rawArgs);
  if (!args) return invalidArgs('args must be an object');
  if (!isWorkEntityKind(args.kind)) {
    return invalidArgs(`kind must be one of: ${WORK_ENTITY_KINDS.join(', ')}`);
  }
  const kind = args.kind;
  // The `core.work-entity.read` VERB-OP fence — FIRST, because it is the coarser
  // axis: it decides whether this caller may use the tool AT ALL, independent of
  // which kind was asked for. Ordering it before the per-kind fence keeps the
  // refusal HONEST — an ungranted caller must be told the verb is missing, not
  // handed a `data.<kind>` hint naming a grant that cannot lift their refusal.
  // Same guided-empty envelope + anti-loop invariant as the fence below.
  if (!deps.isVerbOpGranted(ctx)) {
    return {
      ok: true,
      result: { entities: [], total: 0, hint: workEntityReadVerbOpFencedHint() },
    };
  }
  // D-205 #3 — the `data.<kind>` read fence, BEFORE the resolver is touched. The GUIDED
  // EMPTY (`ok: true` + `hint`), never `ok:false` — the Tier-1 anti-loop invariant. A bare
  // `{ entities: [], total: 0 }` would be indistinguishable from "you have no notes", so
  // the hint is what stops the model reporting a policy refusal as a fact about the world.
  if (!deps.isCollectionReadGranted(kind, ctx)) {
    return {
      ok: true,
      result: { entities: [], total: 0, hint: collectionReadFencedHint(kind) },
    };
  }
  const query = typeof args.query === 'string' && args.query.length > 0
    ? args.query.toLowerCase()
    : undefined;
  const source_id = typeof args.source_id === 'string' && args.source_id.length > 0
    ? args.source_id
    : undefined;
  const done = typeof args.done === 'boolean' ? args.done : undefined;
  if (done !== undefined && kind !== 'task') {
    return invalidArgs("the 'done' filter applies to kind 'task' only");
  }
  const needs = { detail: args.detail === true, current: args.current === true };
  const limit = clampLimit(args.limit);

  const resolver = deps.getResolver();
  if (!resolver) return executionError('work-entity resolver unavailable');
  const external = ctx.channel === 'mcp_wire';
  const registrations = resolver.listSources(kind);
  const targeted = deps.getTargetedReadDeps();
  let limitations: Array<{ source_id: string; limitations: string[] }> = [];
  let narrow: { cap: string; detail: string } | undefined;
  const escalationErrors: WorkEntityEscalationError[] = [];
  const escalatedReads: Array<{ source_id: string; record_ids: string[] }> = [];

  // External doors see only owner-opted-in Sources (mcp_exposed —
  // default OFF). Disabled Sources are excluded from the row read by
  // the store already; the hidden count discloses only Sources whose
  // rows COULD have appeared (enabled, not exposed).
  let exposed: ReadonlySet<string> | null = null;
  let hidden_sources = 0;
  if (external) {
    exposed = new Set(
      registrations
        .filter((s) => s.enabled !== false && s.mcp_exposed)
        .map((s) => s.id),
    );
    hidden_sources = registrations
      .filter((s) => s.enabled !== false && !s.mcp_exposed).length;
    if (source_id !== undefined && !exposed.has(source_id)) {
      return notExposedRejection(source_id);
    }
  }

  let rows: WorkEntity[];
  try {
    rows = source_id !== undefined
      ? resolver.listByKindScoped(kind, source_id, { limit: DISCOVERY_SCAN_CAP })
      : resolver.listByKind(kind, { limit: DISCOVERY_SCAN_CAP });
  } catch (e) {
    if (e instanceof WorkEntityResolverError) return invalidArgs(e.message);
    return executionError(errMessage(e));
  }
  // A read-through declaration is a hard no-materialization boundary. Filter
  // any residue defensively (the boot migration purges it) so an interrupted
  // migration cannot duplicate or serve retained rows.
  const readThroughIds = new Set(
    registrations
      .filter((source) => source.sync_posture === 'read_through')
      .map((source) => source.id),
  );
  rows = rows.filter((row) => !readThroughIds.has(row.source_id));

  // No silent caps: a scan that filled the store ceiling MAY have more
  // rows beyond it — `total` is then a floor, and the result says so
  // (the D-190 `truncated` honesty precedent).
  let scan_truncated = rows.length >= DISCOVERY_SCAN_CAP;
  if (exposed !== null) {
    const allow = exposed;
    rows = rows.filter((r) => allow.has(r.source_id));
  }
  if (done !== undefined) {
    rows = rows.filter((r) => r._kind === 'task' && r.done === done);
  }
  if (query !== undefined) {
    rows = rows.filter((r) => {
      const title = 'title' in r && typeof r.title === 'string' ? r.title : '';
      if (title.toLowerCase().includes(query)) return true;
      const long = workEntityLongText(r);
      return long !== null && long.text.toLowerCase().includes(query);
    });
  }

  // Read-through Sources join the same polymorphic result, but their rows are
  // fetched and projected transiently. The declaration cap applies before any
  // invoke fan-out; over-cap asks for a Source scope instead of guessing which
  // high-security system to query.
  const readThroughSources = registrations.filter((source) =>
    source.sync_posture === 'read_through'
    && source.enabled !== false
    && (source_id === undefined || source.id === source_id)
    && (exposed === null || exposed.has(source.id))
  );
  let readThroughItems: WorkEntityToolItem[] = [];
  if (readThroughSources.length > 0) {
    const maxSources = Math.min(
      ...readThroughSources.map((source) =>
        describeSource(targeted, source.id).policy?.wild_query.max_sources ?? 3),
    );
    if (readThroughSources.length > maxSources) {
      narrow = {
        cap: 'max_sources',
        detail:
          `the query would read ${readThroughSources.length} live Sources; the cap is `
          + `${maxSources} — retry with source_id to choose fewer Sources`,
      };
    } else if (targeted === undefined) {
      for (const source of readThroughSources) {
        escalationErrors.push({
          source_id: source.id,
          kind: 'config',
          reason: 'read-through substrate not wired',
        });
      }
    } else {
      const now = (deps.now ?? Date.now)();
      for (const source of readThroughSources) {
        const live = await runReadThroughList(deps, targeted, source, ctx, now);
        if (!live.ok) {
          escalationErrors.push({ source_id: source.id, kind: live.kind, reason: live.reason });
          continue;
        }
        if (live.truncated) scan_truncated = true;
        if (live.row_error !== undefined) {
          escalationErrors.push({
            source_id: source.id,
            kind: 'projection',
            reason: live.row_error,
          });
        }
        readThroughItems.push(...live.items);
      }
    }
  }
  if (done !== undefined) {
    readThroughItems = readThroughItems.filter((item) => item.done === done);
  }
  if (query !== undefined) {
    readThroughItems = readThroughItems.filter((item) =>
      item.title?.toLowerCase().includes(query) === true
      || item.long_text?.text.toLowerCase().includes(query) === true
    );
  }

  const candidates: Array<
    | { kind: 'local'; updated_at: number; row: WorkEntity }
    | { kind: 'read_through'; updated_at: number; item: WorkEntityToolItem }
  > = [
    ...rows.map((row) => ({ kind: 'local' as const, updated_at: row.updated_at, row })),
    ...readThroughItems.map((item) => ({
      kind: 'read_through' as const,
      updated_at: item.updated_at,
      item,
    })),
  ];
  candidates.sort((a, b) => b.updated_at - a.updated_at);
  const total = candidates.length;
  const pageCandidates = candidates.slice(0, limit);
  const page = pageCandidates
    .filter((candidate): candidate is Extract<(typeof candidates)[number], { kind: 'local' }> =>
      candidate.kind === 'local')
    .map((candidate) => candidate.row);
  let items = pageCandidates.map((candidate) =>
    candidate.kind === 'local'
      ? projectItem(candidate.row, { clampLongText: true })
      : candidate.item
  );

  // Freshness verdicts for the query's scope — same filter composition
  // as the rows (the CRUD handler precedent). Null = sync substrate
  // unwired; the field is then ABSENT (distinguishable from an empty
  // scope, the D-192 wire convention).
  let freshness = resolver.sourceFreshness(kind, {
    ...(source_id !== undefined ? { source_id } : {}),
  });
  if (freshness !== null && exposed !== null) {
    const allow = exposed;
    freshness = freshness.filter((f) => allow.has(f.source_id));
  }

  if ((needs.detail || needs.current) && freshness !== null && page.length > 0) {
    const verdictBySource = new Map(freshness.map((f) => [f.source_id, f]));
    // One wild-query input per Source the PAGE actually draws from —
    // escalating rows the answer will not include would waste the cap.
    const bySource = new Map<string, WorkEntity[]>();
    for (const row of page) {
      const list = bySource.get(row.source_id) ?? [];
      list.push(row);
      bySource.set(row.source_id, list);
    }
    const inputs: WildQuerySourceInput[] = [];
    for (const [sid, sourceRows] of bySource) {
      const verdict = verdictBySource.get(sid);
      if (verdict === undefined) continue; // outside the freshness scope (e.g. disabled)
      const described = describeSource(targeted, sid);
      inputs.push({
        freshness: verdict,
        policy: described.policy,
        has_read_op: described.has_read_op,
        // Rows without a vendor identity (locally created, not yet
        // pushed) have nothing to fetch — the local row IS the truth.
        candidate_record_ids: sourceRows
          .filter((r) => typeof r.source_record_id === 'string')
          .map((r) => r.id),
      });
    }
    const plan = planWorkEntityWildQueryReads(inputs, needs);
    if (plan.mode === 'local') {
      limitations = plan.limitations.map((l) => ({ ...l, limitations: [...l.limitations] }));
    } else if (plan.mode === 'ask_to_narrow') {
      narrow = { cap: plan.cap, detail: plan.detail };
      limitations = plan.limitations.map((l) => ({ ...l, limitations: [...l.limitations] }));
    } else {
      limitations = plan.limitations.map((l) => ({ ...l, limitations: [...l.limitations] }));
      const byId = new Map(page.map((r) => [r.id, r]));
      const origin = escalationOrigin(ctx);
      for (const read of plan.reads) {
        if (targeted === undefined) {
          escalationErrors.push({
            source_id: read.source_id,
            kind: 'config',
            reason: 'targeted-read substrate not wired',
          });
          continue;
        }
        const prep = prepareWorkEntitySourceTargetedRead(targeted, {
          source_id: read.source_id,
        });
        if (!prep.ok) {
          escalationErrors.push({ source_id: read.source_id, kind: prep.kind, reason: prep.reason });
          continue;
        }
        // THE ADMISSION SEAM — after prepare (admission needs the
        // bound catalog + the declared read op), before any vendor
        // invoke (prepare is pure config resolution, so a refusal
        // keeps the zero-invoke property). Mirrors the door's own
        // dispatch order: resolve the binding, then admit.
        const admission = admitEscalation(deps, ctx, {
          catalogSlug: prep.prepared.catalogSlug,
          manifest: prep.prepared.manifest,
          operation: prep.prepared.readOp.opKey,
        });
        if (!admission.admitted) {
          escalationErrors.push({
            source_id: read.source_id,
            kind: 'policy',
            reason: admission.reason,
          });
          continue;
        }
        const succeeded: string[] = [];
        for (const record_id of read.record_ids) {
          const row = byId.get(record_id);
          const source_record_id = row?.source_record_id;
          if (row === undefined || typeof source_record_id !== 'string') continue;
          const live = await readLive(targeted, prep.prepared, source_record_id, origin);
          if (!live.ok) {
            escalationErrors.push({ source_id: read.source_id, kind: live.kind, reason: live.reason });
            // A failed Source fails for the rest of its records too
            // (policy refusals + config gaps are per-Source); stop
            // rather than repeat the same denied invoke.
            break;
          }
          succeeded.push(record_id);
          items = items.map((item) =>
            item.id === record_id
              ? live.projected !== null
                ? overlayLive(item, live.projected, live.long)
                : { ...item, live: true, ...(live.long !== null ? { long_text: live.long } : {}) }
              : item,
          );
        }
        if (succeeded.length > 0) {
          escalatedReads.push({ source_id: read.source_id, record_ids: succeeded });
        }
      }
    }
  }

  const rowByLocalId = new Map(page.map((row) => [row.id, row]));
  const qualifyLocalId = (localId: string): string => {
    const row = rowByLocalId.get(localId);
    return row === undefined ? localId : qualifiedIdForEntity(row);
  };
  return {
    ok: true,
    result: {
      entities: items.map((item) => {
        const row = rowByLocalId.get(item.id);
        return row === undefined ? item : qualifyItem(row, item);
      }),
      total,
      ...(scan_truncated ? { scan_truncated } : {}),
      ...(freshness !== null ? { source_freshness: freshness } : {}),
      ...(limitations.length > 0 ? { limitations } : {}),
      ...(narrow !== undefined ? { narrow } : {}),
      ...(escalatedReads.length > 0
        ? {
            escalated: escalatedReads.map((entry) => ({
              ...entry,
              record_ids: entry.record_ids.map(qualifyLocalId),
            })),
          }
        : {}),
      ...(escalationErrors.length > 0 ? { escalation_errors: escalationErrors } : {}),
      ...(external && hidden_sources > 0 ? { hidden_sources } : {}),
    },
  };
};

// ────────────────────────────────────────────────────────────────
// work.read
// ────────────────────────────────────────────────────────────────

const READ_FIDELITIES: ReadonlySet<string> = new Set([
  'rich_meta',
  'remote_detail',
  'current_remote',
]);

export const runWorkEntityReadTool = async (
  deps: WorkEntityReadToolsDeps,
  rawArgs: unknown,
  ctx: ChatDispatchContext,
): Promise<ChatDispatchResult> => {
  const args = asObject(rawArgs);
  if (!args) return invalidArgs('args must be an object');
  if (!isWorkEntityKind(args.kind)) {
    return invalidArgs(`kind must be one of: ${WORK_ENTITY_KINDS.join(', ')}`);
  }
  const kind = args.kind;
  // D-205 #3 — the `data.<kind>` read fence, BEFORE the resolver is touched.
  //
  // ⚠ This tool's not-found shape is `{ entity: null, found: false }`, so a refusal that
  // reused it would tell the model **"that task does not exist"** — a policy decision
  // laundered into a fact about the world, and the model states it to the user as one. The
  // `hint` is the ONLY thing separating "you may not read this" from "this is not there";
  // it says so in as many words. Still `ok: true` (the Tier-1 anti-loop invariant).
  // The `core.work-entity.read` VERB-OP fence — FIRST (the coarser axis; see the
  // twin in `runWorkEntitySearchTool`). This tool's not-found shape lies harder
  // than the search tool's: `{ entity: null, found: false }` reads as "that task
  // does not exist", so an unlabelled verb refusal here becomes a policy decision
  // laundered into a fact about a SPECIFIC record the user just named.
  if (!deps.isVerbOpGranted(ctx)) {
    return {
      ok: true,
      result: { entity: null, found: false, hint: workEntityReadVerbOpFencedHint() },
    };
  }
  if (!deps.isCollectionReadGranted(kind, ctx)) {
    return {
      ok: true,
      result: { entity: null, found: false, hint: collectionReadFencedHint(kind) },
    };
  }
  const id = typeof args.id === 'string' && args.id.length > 0 ? args.id : undefined;
  if (id === undefined) return invalidArgs('id is required');
  let fidelity: WorkEntityReadFidelity = 'rich_meta';
  if (args.fidelity !== undefined) {
    // `write_preflight` is the write executor's internal class — the
    // model never requests it; a write's preflight read rides the
    // write dispatch itself.
    if (typeof args.fidelity !== 'string' || !READ_FIDELITIES.has(args.fidelity)) {
      return invalidArgs('fidelity must be one of: rich_meta, remote_detail, current_remote');
    }
    fidelity = args.fidelity as WorkEntityReadFidelity;
  }

  const resolver = deps.getResolver();
  if (!resolver) return executionError('work-entity resolver unavailable');

  let entity: WorkEntity | null;
  try {
    const qualified = parseQualifiedWorkEntityId(id);
    if (qualified !== null && qualified.kind !== kind) {
      return invalidArgs(
        `QUALIFIED_ID_KIND_MISMATCH: work.read requested '${kind}', but the id is for `
          + `'${qualified.kind}'. Retry with kind '${qualified.kind}' and the same id.`,
      );
    }
    if (qualified?.identity === 'source') {
      const registration = resolver
        .listSources(kind)
        .find((source) => source.id === qualified.source_id);
      if (registration?.sync_posture === 'read_through') {
        if (registration.enabled === false) {
          return invalidArgs(
            `source '${registration.id}' is disabled in Settings → Work Entities`,
          );
        }
        if (ctx.channel === 'mcp_wire' && !registration.mcp_exposed) {
          return { ok: true, result: { entity: null, found: false } };
        }
        const now = (deps.now ?? Date.now)();
        const freshness = classifyWorkEntitySourceFreshness(registration, null, now);
        const targeted = deps.getTargetedReadDeps();
        const plan: WorkEntityReadPlan = {
          action: 'remote',
          reasons: ['current_remote_required'],
        };
        if (targeted === undefined) {
          return executionError(
            `read-through source '${registration.id}' could not be read: targeted-read substrate not wired`,
          );
        }
        const prep = prepareWorkEntitySourceTargetedRead(targeted, {
          source_id: registration.id,
        });
        if (!prep.ok) {
          return executionError(
            `read-through source '${registration.id}' could not be read: ${prep.reason}`,
          );
        }
        const admission = admitEscalation(deps, ctx, {
          catalogSlug: prep.prepared.catalogSlug,
          manifest: prep.prepared.manifest,
          operation: prep.prepared.readOp.opKey,
        });
        if (!admission.admitted) {
          return executionError(
            `read-through source '${registration.id}' could not be read: ${admission.reason}`,
          );
        }
        const live = await readLive(
          targeted,
          prep.prepared,
          qualified.record_id,
          escalationOrigin(ctx),
        );
        if (!live.ok) {
          return executionError(
            `read-through source '${registration.id}' could not be read: ${live.reason}`,
          );
        }
        if (live.projected === null) {
          return executionError(
            `read-through source '${registration.id}' returned a record that failed canonical projection`,
          );
        }
        return {
          ok: true,
          result: {
            entity: projectReadThroughItem(live.projected, now, {
              clampLongText: false,
              longOverride: live.long,
            }),
            found: true,
            source_freshness: freshness,
            plan,
            live_read_at: now,
          },
        };
      }
    } else if (qualified?.identity === 'local') {
      const registration = resolver
        .listSources(kind)
        .find((source) => source.id === qualified.source_id);
      if (registration?.sync_posture === 'read_through') {
        return invalidArgs(
          `QUALIFIED_ID_LOCAL_ONLY: source '${registration.id}' is read_through and has no `
          + 'local row id. Retry with work.search and pass its source-qualified id unchanged.',
        );
      }
    }
    entity = qualified === null
      ? resolver.readEntity(kind, id)
      : qualified.identity === 'source'
        ? resolver.readEntityBySourceIdentity(
            kind,
            qualified.source_id,
            qualified.record_id,
          )
        : resolver.readEntity(kind, qualified.record_id);
    if (
      qualified?.identity === 'local'
      && entity !== null
      && entity.source_id !== qualified.source_id
    ) {
      return invalidArgs(
        `SOURCE_MISMATCH: the id names source '${qualified.source_id}', but the row belongs `
          + `to '${entity.source_id}'. Retry with 'work.search' and pass the returned id unchanged.`,
      );
    }
  } catch (e) {
    if (e instanceof QualifiedWorkEntityIdError) return invalidArgs(e.message);
    if (e instanceof WorkEntityResolverError) return invalidArgs(e.message);
    return executionError(errMessage(e));
  }
  if (entity === null) {
    return { ok: true, result: { entity: null, found: false } };
  }
  const row = entity;
  if (ctx.channel === 'mcp_wire') {
    const registration = resolver
      .listSources(kind)
      .find((s) => s.id === row.source_id);
    // A disabled Source's rows are excluded from polymorphic reads
    // (PA11) — an external door must not keep reading a Source the
    // owner switched off just because its `mcp_exposed` flag survived
    // the disable (codex MEDIUM). The owner's own by-id read keeps the
    // CRUD `get` disabled-row visibility.
    if (
      registration === undefined
      || !registration.mcp_exposed
      || registration.enabled === false
    ) {
      // Deliberately indistinguishable from a missing row: an external
      // door must not learn row existence inside a Source the owner
      // kept private. Source-LEVEL coverage is disclosed by
      // `work.search`'s `hidden_sources` instead.
      return { ok: true, result: { entity: null, found: false } };
    }
  }

  const now = (deps.now ?? Date.now)();
  const targeted = deps.getTargetedReadDeps();
  // By-id reads surface disabled-Source rows (the CRUD `get`
  // precedent), so the verdict lookup passes include_disabled too.
  const verdicts = resolver.sourceFreshness(kind, {
    source_id: row.source_id,
    include_disabled: true,
  });
  const freshness: WorkEntitySourceFreshness = verdicts?.[0]
    ?? classifyWorkEntitySourceFreshness(
      resolver.listSources(kind).find((s) => s.id === row.source_id)
        ?? { id: row.source_id, source_kind: 'connection' },
      null,
      now,
    );
  const described = describeSource(targeted, row.source_id);
  const plan: WorkEntityReadPlan = resolveWorkEntityReadPlan({
    fidelity,
    freshness,
    policy: described.policy,
    has_read_op: described.has_read_op,
  });

  const item = qualifyItem(row, projectItem(row, { clampLongText: false }));
  const base = {
    entity: item,
    found: true as const,
    source_freshness: freshness,
    plan,
  };
  if (plan.action === 'local') {
    return { ok: true, result: base };
  }

  // Remote plan — targeted vendor read, degrading to the honest local
  // row on any failure (the local answer plus a named escalation_error;
  // the agent should answer from it and tell the user, not retry).
  const degrade = (kindOf: WorkEntityEscalationError['kind'], reason: string): ChatDispatchResult => ({
    ok: true,
    result: {
      ...base,
      escalation_error: { source_id: row.source_id, kind: kindOf, reason },
    },
  });
  const readOrigin = escalationOrigin(ctx);
  if (targeted === undefined) {
    return degrade('config', 'targeted-read substrate not wired');
  }
  const source_record_id = row.source_record_id;
  if (typeof source_record_id !== 'string' || source_record_id.length === 0) {
    return degrade(
      'config',
      'the row has no vendor record identity (locally created, not yet pushed) — the local row is authoritative',
    );
  }
  const prep = prepareWorkEntitySourceTargetedRead(targeted, {
    source_id: row.source_id,
  });
  if (!prep.ok) return degrade(prep.kind, prep.reason);
  // THE ADMISSION SEAM — after prepare, before the vendor invoke
  // (the door-dispatch order: resolve the binding, then admit).
  const admission = admitEscalation(deps, ctx, {
    catalogSlug: prep.prepared.catalogSlug,
    manifest: prep.prepared.manifest,
    operation: prep.prepared.readOp.opKey,
  });
  if (!admission.admitted) return degrade('policy', admission.reason);
  const live = await readLive(targeted, prep.prepared, source_record_id, readOrigin);
  if (!live.ok) return degrade(live.kind, live.reason);
  const refreshed = live.projected !== null
    ? overlayLive(item, live.projected, live.long)
    : { ...item, live: true as const, ...(live.long !== null ? { long_text: live.long } : {}) };
  return {
    ok: true,
    result: {
      ...base,
      entity: refreshed,
      live_read_at: now,
    },
  };
};
