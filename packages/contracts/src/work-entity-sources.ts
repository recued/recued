/** D-192 P1 — Declared work-entity Source sync contract.
 *
 *  A catalog manifest's top-level `work_entity_sources` array makes one
 *  remote entity collection a Source for exactly one Recued work entity
 *  kind (`task` / `note` / `project` — `commitment` is reserved for the
 *  separate stricter `commitment_evidence` kind, D-192 F1). P1 is
 *  declaration + fail-closed validation ONLY: packs declare intent, no
 *  runtime behavior changes (no Source registration, no sync runner).
 *
 *  The shape mirrors D-192 § Contract shape with the
 *  2026-07-01 amendments folded in: `sync.depth` is `'meta'` only (fork
 *  F3 dropped `full`), relationship `write_back` is fail-closed `false`
 *  in v1, and the schema-proof burden is split — op-level proof is
 *  mechanical (`crossCheckCatalogOpenApi`), field-path proof is
 *  authoring discipline + risk-based marketplace review.
 *
 *  Spec: D-192 · decisions-log D-192. */

// ────────────────────────────────────────────────────────────────
// Closed enums
// ────────────────────────────────────────────────────────────────

/** Kernel landing contracts for pack-declared work-entity Sources.
 *
 *  This is deliberately stronger than a naked kind allowlist. An entry says
 *  where each posture lands at the generic entity boundary: mirrored rows in
 *  the canonical `data.<kind>` collection, or transient rows returned through
 *  `work.search` / `work.read`. The server's executable adapter registry is
 *  typed as an exact `Record<WorkEntitySourceDeclarableKind, ...>` over these
 *  keys, so adding a pack-declarable kind here makes the build fail until its
 *  projector, store, tombstone, and qualified-id adapter exists.
 *
 *  `commitment` and `booking` are intentionally absent. They have canonical
 *  local entities and `we1` identities, but no external Source landing
 *  semantics; a pack must not be able to declare one merely because the base
 *  entity type exists. */
export const WORK_ENTITY_SOURCE_LANDING_CONTRACTS = {
  task: {
    canonical_collection: 'data.task',
    qualified_id_namespace: 'we1',
    postures: ['records', 'read_through'],
  },
  note: {
    canonical_collection: 'data.note',
    qualified_id_namespace: 'we1',
    postures: ['records', 'read_through'],
  },
  project: {
    canonical_collection: 'data.project',
    qualified_id_namespace: 'we1',
    postures: ['records', 'read_through'],
  },
} as const;

export type WorkEntitySourceDeclarableKind = keyof typeof WORK_ENTITY_SOURCE_LANDING_CONTRACTS;
export type WorkEntitySourceLandingContract =
  (typeof WORK_ENTITY_SOURCE_LANDING_CONTRACTS)[WorkEntitySourceDeclarableKind];

export const WORK_ENTITY_SOURCE_DECLARABLE_KINDS = Object.freeze(
  Object.keys(WORK_ENTITY_SOURCE_LANDING_CONTRACTS) as WorkEntitySourceDeclarableKind[],
);
export const WORK_ENTITY_SOURCE_DECLARABLE_KIND_SET: ReadonlySet<string> = new Set(WORK_ENTITY_SOURCE_DECLARABLE_KINDS);

/** Resolve the landing contract a pack declaration may target. Null means the
 *  kernel has no complete runtime landing adapter and publish must fail. */
export const getWorkEntitySourceLandingContract = (
  kind: unknown,
): WorkEntitySourceLandingContract | null =>
  typeof kind === 'string'
  && Object.prototype.hasOwnProperty.call(WORK_ENTITY_SOURCE_LANDING_CONTRACTS, kind)
    ? WORK_ENTITY_SOURCE_LANDING_CONTRACTS[kind as WorkEntitySourceDeclarableKind]
    : null;

/** Narrowing guard — `WORK_ENTITY_SOURCE_DECLARABLE_KIND_SET.has()` is
 *  typed `ReadonlySet<string>` and does NOT narrow, so callers wanting
 *  the narrowed kind had been hand-spelling the exclusion instead
 *  (`if (kind === 'commitment') refuse`). That form silently admits
 *  every kind added later: `booking` (D-210) is Recued-local and must
 *  never reach the vendor mirror, but an exclusion list naming only
 *  `commitment` would have let it through. Ask this instead. */
export const isWorkEntitySourceDeclarableKind = (
  v: string,
): v is WorkEntitySourceDeclarableKind => WORK_ENTITY_SOURCE_DECLARABLE_KIND_SET.has(v);

export const WORK_ENTITY_SYNC_MODES = ['read_only', 'read_write'] as const;
export type WorkEntitySyncMode = (typeof WORK_ENTITY_SYNC_MODES)[number];

/** Whether a declared work-entity Source materializes canonical rows or is
 *  read directly on demand. Omission is the backward-compatible `records`
 *  posture. Kept narrower than the global Source posture enum: file/contact
 *  families use their own declaration contracts. */
export const WORK_ENTITY_SOURCE_POSTURES = ['records', 'read_through'] as const;
export type WorkEntitySourcePosture = (typeof WORK_ENTITY_SOURCE_POSTURES)[number];

/** Fork F3 (2026-07-01): `'meta'` is the ONLY sync depth — `full` was
 *  dropped, not deferred. The field stays declared so a future depth is
 *  an explicit contract change rather than an inference. */
export const WORK_ENTITY_SYNC_DEPTHS = ['meta'] as const;
export type WorkEntitySyncDepth = (typeof WORK_ENTITY_SYNC_DEPTHS)[number];

export const WORK_ENTITY_TOMBSTONE_KINDS = ['native', 'missing_means_deleted', 'none'] as const;
export type WorkEntityTombstoneKind = (typeof WORK_ENTITY_TOMBSTONE_KINDS)[number];

/** D-192 CORE #8b — what a list-op row CARRIES (a fact about the
 *  vendor's API, not a behavior knob — the engine derives the behavior).
 *
 *  - `record` (the default when absent) — the row IS the record:
 *    projection, tombstone, version, and hash fields all read off it.
 *  - `reference` — the row carries identity only (Azure DevOps WIQL
 *    returns `WorkItemReference` rows of `id` + `url`): every listed row
 *    is HYDRATED through the declared read op (`ops.read` +
 *    `op_bindings.read.id_arg`, with `op_arg_bindings.read` /
 *    read-bound persist-dependency scoping args) BEFORE the tombstone
 *    check and projection. The ONLY field the engine reads off a
 *    reference row is `remote.id` (the walk's row key — it must appear
 *    under the same path on the read response, and the hydrated
 *    record's id must MATCH the requested one; drift fails the row).
 *    Hydration costs one gated read per listed row per cycle — a
 *    reference list has no change signal to hash-skip against — so the
 *    walk is bounded by `WORK_ENTITY_LIST_HYDRATION_MAX_ROWS_PER_CYCLE`
 *    (rows beyond it fail closed and degrade the Source; narrow the
 *    list scope). */
export const WORK_ENTITY_LIST_ROW_KINDS = ['record', 'reference'] as const;
export type WorkEntityListRowKind = (typeof WORK_ENTITY_LIST_ROW_KINDS)[number];

/** `missing_means_deleted` is allowed only when the declaration asserts
 *  the list op is a complete authoritative scan for the Source scope
 *  (spec § Sync contract). The assertion is an explicit declared field
 *  so the validator can fail closed on its absence — a filtered list
 *  ("open tasks assigned to me") must declare `'filtered'` and use
 *  `native` tombstones or `none`. */
export const WORK_ENTITY_LIST_SCOPES = ['complete_authoritative', 'filtered'] as const;
export type WorkEntityListScope = (typeof WORK_ENTITY_LIST_SCOPES)[number];

/** D-192 CORE #8c adds `'none'` — the declared TOKENLESS posture for a
 *  pinned schema that exposes NO version signal at all (Microsoft
 *  Planner's `plannerTask` has no `updated_at`, no revision counter,
 *  and no `@odata.etag` in the pinned Graph OpenAPI). Like `list_rows`,
 *  the kind states a FACT about the vendor's API, not a behavior knob:
 *  with `'none'` the engine derives the behavior — change detection
 *  rides the local `source_record_hash` compare (computed for every
 *  Source anyway), `source_version_token` / `source_updated_at` are
 *  never populated, and conditional writes are impossible (the
 *  validator forces `write_policy.conditional_write: 'none'`).
 *  Declaring a version FIELD the schema doesn't prove — the attio
 *  `version←created_at` caveat class — is exactly what this kind
 *  exists to avoid. */
export const WORK_ENTITY_VERSION_KINDS = ['updated_at', 'etag', 'revision', 'hash', 'none'] as const;
export type WorkEntityVersionKind = (typeof WORK_ENTITY_VERSION_KINDS)[number];

export const WORK_ENTITY_CURSOR_KINDS = ['updated_since'] as const;
export type WorkEntityCursorKind = (typeof WORK_ENTITY_CURSOR_KINDS)[number];

export const WORK_ENTITY_CONDITIONAL_WRITE_KINDS = ['none', 'etag', 'revision', 'updated_at'] as const;
export type WorkEntityConditionalWriteKind = (typeof WORK_ENTITY_CONDITIONAL_WRITE_KINDS)[number];

/** D-145 conflict vocabulary (spec § Conflict model). */
export const WORK_ENTITY_CONFLICT_RESOLUTIONS = ['source_wins', 'recued_wins', 'manual_merge'] as const;
export type WorkEntityConflictResolution = (typeof WORK_ENTITY_CONFLICT_RESOLUTIONS)[number];

export const WORK_ENTITY_PAIRING_MODES = ['remote_id', 'canonical_id', 'lookup'] as const;
export type WorkEntityPairingMode = (typeof WORK_ENTITY_PAIRING_MODES)[number];

/** `pairing: 'lookup'` must declare WHAT resolves the reference (spec
 *  § Identity and relationships: "resolved through email, URL, slug, or
 *  an external key") — a lookup with no declared key is
 *  resolve-by-guessing, which the invariants forbid (Codex review
 *  fold). The full scoped target tuple (`target_source_id` /
 *  `target_scope` / `target_remote_*`) is DERIVED at resolution time
 *  from the declaration's connection + `remote_entity` + this key — it
 *  is not author-declarable. */
export const WORK_ENTITY_LOOKUP_KEYS = ['email', 'url', 'slug', 'external_key'] as const;
export type WorkEntityLookupKey = (typeof WORK_ENTITY_LOOKUP_KEYS)[number];

/** Closed relationship-target set (spec § Identity and relationships).
 *  `file` is deliberately ABSENT — entity→file rides the D-172
 *  attachment idiom (`data.link role:'attachment'`), never the work
 *  graph (owner, 2026-07-01). Unsupported domain nouns stay vendor
 *  metadata in the extension lane. */
export const WORK_ENTITY_RELATIONSHIP_TARGETS = [
  'task', 'project', 'note', 'contact', 'calendar.event', 'mail_message',
  'crm.deal', 'crm.contact', 'crm.account',
] as const;
export type WorkEntityRelationshipTarget = (typeof WORK_ENTITY_RELATIONSHIP_TARGETS)[number];
export const WORK_ENTITY_RELATIONSHIP_TARGET_SET: ReadonlySet<string> =
  new Set(WORK_ENTITY_RELATIONSHIP_TARGETS);

/** Closed remote-escalation reasons (spec § Read resolution policy). */
export const WORK_ENTITY_REMOTE_WHEN_REASONS = [
  'field_missing', 'source_stale', 'complete_body_required', 'comments_required',
  'attachments_required', 'current_remote_required', 'write_preflight',
] as const;
export type WorkEntityRemoteWhenReason = (typeof WORK_ENTITY_REMOTE_WHEN_REASONS)[number];
export const WORK_ENTITY_REMOTE_WHEN_REASON_SET: ReadonlySet<string> =
  new Set(WORK_ENTITY_REMOTE_WHEN_REASONS);

/** The declared write-capable op slots. `list` / `read` are the read
 *  side; everything else requires `sync.mode: 'read_write'` + a write
 *  policy. */
export const WORK_ENTITY_OP_SLOTS = ['list', 'read', 'create', 'update', 'delete', 'complete'] as const;
export type WorkEntityOpSlot = (typeof WORK_ENTITY_OP_SLOTS)[number];
export const WORK_ENTITY_WRITE_OP_SLOTS: readonly WorkEntityOpSlot[] =
  ['create', 'update', 'delete', 'complete'];

// ────────────────────────────────────────────────────────────────
// Per-kind canonical projection vocabulary
// ────────────────────────────────────────────────────────────────
//
// Closed allowlists — anything else fails validation. Three exclusions
// are deliberate (spec § Sync depth + § Identity and relationships):
//   1. long-body columns (`task.body` / `note.body` /
//      `project.description`) are NEVER canonical projection targets on
//      a meta Source — bounded body text rides the `preview` lane;
//   2. relationship/FK fields (`assigned_contact_id`,
//      `parent_project_id`, `related_*`, `blocks_task_ids`) are NEVER
//      projection targets — a raw vendor id must not reach a canonical
//      local-id column; relationships ride the `relationships` array;
//   3. identity/system fields (`id`, `created_at`, `updated_at`,
//      `source_*`) are runtime-owned.

export const WORK_ENTITY_SOURCE_CANONICAL_FIELDS: Record<WorkEntitySourceDeclarableKind, readonly string[]> = {
  task: ['title', 'done', 'state', 'progress', 'due_at', 'priority', 'completed_at'],
  note: ['title'],
  project: ['title', 'state', 'target_completion_at'],
};

/** Minimum canonical projection per kind (spec § Validation invariants
 *  "projection omits required canonical fields"). A `note` has no
 *  required canonical column (`title` is optional on the canonical
 *  shape) — it must instead project at least one preview field, which
 *  the validator checks separately. A `task` additionally requires a
 *  COMPLETION SIGNAL — `done` OR `state` (P1b coverage finding: real
 *  vendors model completion as a state enum, not a boolean —
 *  GitHub `state`, Jira `status`, HubSpot `hs_task_status` — so
 *  requiring the boolean `done` would false-reject them; the P3
 *  projection layer normalizes via the closed derivation set). The
 *  either-of rule is checked separately by the validator. */
export const WORK_ENTITY_SOURCE_REQUIRED_CANONICAL: Record<WorkEntitySourceDeclarableKind, readonly string[]> = {
  task: ['title'],
  note: [],
  project: ['title', 'state'],
};

/** D-192 CORE #8c — canonical fields that may be DERIVED (a closed
 *  derivation object in `projection.canonical` instead of a remote
 *  field path). v1: task `done` only — the completion-signal invariant
 *  stays `done` OR `state`, and a vendor that models completion as a
 *  NUMBER (Microsoft Planner `percentComplete`, "When set to 100, the
 *  task is considered completed") satisfies it by deriving the boolean
 *  explicitly rather than abusing `state: percentComplete` or leaning
 *  on `progress` (which alone stays insufficient — a bare number does
 *  not state the vendor's completion convention; the derivation makes
 *  the convention a declared, reviewable fact). Grows per verified
 *  vendor need, same posture as `WORK_ENTITY_WRITE_DATE_FORMATS`. */
export const WORK_ENTITY_SOURCE_DERIVABLE_CANONICAL: Record<WorkEntitySourceDeclarableKind, readonly string[]> = {
  task: ['done'],
  note: [],
  project: [],
};

/** D-192 CORE #8d — canonical fields that may COALESCE (an ordered
 *  ARRAY of remote field paths in `projection.canonical`; the first
 *  USABLE candidate wins — absent values skip, and a candidate the
 *  field's own coercion rejects skips too, so a fallback exists
 *  precisely for the rows where the primary is unusable). v1: `title`
 *  only — the required display field where a declared lesser source
 *  (Outreach `note` → the `action` type slug) beats failing the row
 *  closed on note-less/long-note records. Deliberately NOT completion
 *  signals (`done`/`state`): a coercion-failure fall-through on a
 *  completion field could silently flip completion off a garbage
 *  primary value. Grows per verified vendor need, same posture as
 *  `WORK_ENTITY_SOURCE_DERIVABLE_CANONICAL` (the asana due-time
 *  `due_at ← [due_at, due_on]` case is the known next candidate). */
export const WORK_ENTITY_SOURCE_COALESCABLE_CANONICAL: Record<WorkEntitySourceDeclarableKind, readonly string[]> = {
  task: ['title'],
  note: ['title'],
  project: ['title'],
};

/** D-192 CORE #8e — canonical fields that may be DERIVED via a whitelisted
 *  pure transform (a `{ kind: 'transform', field, transform }` object in
 *  `projection.canonical`; the transform runs over a remote text path and
 *  the output coerces through the field's own coercion). v1: `title` only
 *  — the display field a vendor may expose only as markup (Confluence
 *  inline tasks carry no title, only an XHTML `body.storage.value`).
 *  Deliberately DISJOINT from the `number_equals` derivable set
 *  (`WORK_ENTITY_SOURCE_DERIVABLE_CANONICAL`, boolean `done`): a transform
 *  produces a STRING, `number_equals` a boolean, and the validator gates
 *  each kind to its output-appropriate fields so neither can target the
 *  other's. Grows per verified vendor need, same posture as the sibling
 *  applicability sets. */
export const WORK_ENTITY_SOURCE_TRANSFORMABLE_CANONICAL: Record<WorkEntitySourceDeclarableKind, readonly string[]> = {
  task: ['title'],
  note: ['title'],
  project: ['title'],
};

/** Relationship `local_field` allowlist per kind — the FK/edge fields
 *  the canonical shapes actually carry. A relationship may only bind to
 *  one of these; projection lanes may never touch them. */
export const WORK_ENTITY_SOURCE_RELATIONSHIP_LOCAL_FIELDS: Record<WorkEntitySourceDeclarableKind, readonly string[]> = {
  task: ['assigned_contact_id', 'parent_project_id', 'parent_calendar_event_id', 'linked_mail_thread_id', 'blocks_task_ids'],
  note: ['related_contact_ids', 'related_calendar_event_ids', 'related_mail_thread_ids', 'related_project_ids'],
  project: ['related_contact_ids', 'parent_project_id'],
};

// ────────────────────────────────────────────────────────────────
// v1 projection caps (spec § Sync depth "Hard v1 projection caps")
// ────────────────────────────────────────────────────────────────

export const WORK_ENTITY_PREVIEW_DEFAULT_MAX_CHARS = 800;
export const WORK_ENTITY_PREVIEW_HARD_MAX_CHARS = 2_000;
export const WORK_ENTITY_EXTENSION_BLOB_MAX_BYTES = 8 * 1024;
export const WORK_ENTITY_EXTENSION_SCALAR_MAX_CHARS = 500;
export const WORK_ENTITY_EXTENSION_ARRAY_MAX_ITEMS = 50;
export const WORK_ENTITY_EXTENSION_MAX_DEPTH = 3;
/** Declared extension entries per Source (shape-level bound on the
 *  declaration itself; the 8 KiB byte cap gates runtime rows). */
export const WORK_ENTITY_EXTENSION_MAX_ENTRIES = 50;
/** D-192 CORE #8b — per-cycle bound on `list_rows: 'reference'`
 *  hydration reads. A reference walk fires one gated read PER LISTED
 *  ROW (no change signal to skip on), so a misdeclared/unbounded list
 *  op must not turn one housekeeping cycle into thousands of vendor
 *  calls. Generous against the first-page-only list posture the
 *  shipped vendors hold (50–100 rows); rows beyond the cap fail closed
 *  (row failure + degraded Source — spec § Sync depth's over-cap
 *  posture), never a silent partial mirror that reads healthy. */
export const WORK_ENTITY_LIST_HYDRATION_MAX_ROWS_PER_CYCLE = 200;

// ────────────────────────────────────────────────────────────────
// Declaration shape
// ────────────────────────────────────────────────────────────────

/** Admitted contract-source kinds (owner decision 2026-07-01, resolving
 *  the P1b Google-Discovery fork): `openapi` (the default), and
 *  `google_discovery` — Google publishes Discovery documents
 *  (`discovery#restDescription`, `resources.*.methods` with
 *  `httpMethod` + `path`), not OpenAPI; the format is equally official
 *  and mechanically provable, so it gets its own kind + prover
 *  (`crossCheckCatalogGoogleDiscovery`) rather than an exclusion.
 *  `graphql` (D-192 Gate E′) — a pinned GraphQL SDL or introspection
 *  document (`surfaces.api.graphql_schema_source`); each graphql op's
 *  query is proven against it by `crossCheckGraphqlSchema` (full
 *  graphql-js parse + build-schema + validate — op + selected-field
 *  existence), the transport-appropriate analog of the REST
 *  `(method, path)` proof. Non-`(method, path)` — a graphql op has no
 *  path — so the proof is schema-validity, not endpoint matching. */
export const WORK_ENTITY_CONTRACT_SOURCE_KINDS = ['openapi', 'google_discovery', 'graphql'] as const;
export type WorkEntityContractSourceKind = (typeof WORK_ENTITY_CONTRACT_SOURCE_KINDS)[number];

/** The catalog surface pin each contract-source kind must reference and
 *  EQUAL (one document, one pin). */
export const WORK_ENTITY_CONTRACT_SOURCE_SURFACES: Record<
  WorkEntityContractSourceKind,
  'surfaces.api.openapi_source' | 'surfaces.api.google_discovery_source' | 'surfaces.api.graphql_schema_source'
> = {
  openapi: 'surfaces.api.openapi_source',
  google_discovery: 'surfaces.api.google_discovery_source',
  graphql: 'surfaces.api.graphql_schema_source',
};

/** The synchronously-dispatchable API execution-binding kind each
 *  contract-source's pinned doc PROVES: REST `(method, path)` for
 *  `openapi` / `google_discovery`, a graphql query/mutation for
 *  `graphql`. Every Source op's binding kind must EQUAL this
 *  (`validate-work-entity-sources`) so no op escapes its transport's
 *  prover — a Source pins ONE schema doc, and each op must be provable
 *  against exactly that doc (a graphql op has no `(method, path)` for a
 *  REST prover; a REST op is invisible to `crossCheckGraphqlSchema`).
 *  Adding a contract-source kind forces its provable transport here. */
export const WORK_ENTITY_CONTRACT_SOURCE_TRANSPORT: Record<
  WorkEntityContractSourceKind,
  'rest' | 'graphql'
> = {
  openapi: 'rest',
  google_discovery: 'rest',
  graphql: 'graphql',
};

/** Binds the Source declaration to the catalog's pinned schema source.
 *  `url` + `sha256` must EQUAL the surface pin the `kind` maps to
 *  (`WORK_ENTITY_CONTRACT_SOURCE_SURFACES` — one document, one pin);
 *  `operations` is the author's coverage assertion and must be a
 *  superset of every op named in `ops`. Op-level proof against the pinned
 *  document is mechanical + transport-appropriate — REST `(method, path)`
 *  via `crossCheckCatalogOpenApi` / `crossCheckCatalogGoogleDiscovery`,
 *  GraphQL op + selected-field existence via `crossCheckGraphqlSchema`;
 *  field-path proof is authoring discipline + risk-based marketplace
 *  review (D-192 owner decision). */
export interface WorkEntitySourceContractSource {
  kind: WorkEntityContractSourceKind;
  surface: 'surfaces.api.openapi_source' | 'surfaces.api.google_discovery_source' | 'surfaces.api.graphql_schema_source';
  url: string;
  sha256: string;
  operations: string[];
}

export interface WorkEntitySourceRemoteVersion {
  kind: WorkEntityVersionKind;
  /** Response field carrying the version. Required for `updated_at` /
   *  `revision` / `hash`; an `etag` may live in a response header, so
   *  the field is optional there. FORBIDDEN for `'none'` — the kind
   *  asserts no version signal exists, and the field gate is
   *  load-bearing: the projector mints `source_version_token` from any
   *  declared field, so a `'none'` declaration carrying one would
   *  quietly become a token-bearing Source (D-192 CORE #8c). */
  field?: string;
}

/** Remote identity: one remote entity collection per declaration
 *  (single-entity rule). */
export interface WorkEntitySourceRemote {
  entity: string;
  /** Response field carrying the vendor-native record id. */
  id: string;
  /** The CREATE response's id field, when the vendor's create response
   *  is a DIFFERENT shape than its record reads — Salesforce `POST
   *  /sobjects/<entity>` returns `{ id, success, errors }` (lowercase)
   *  while its SOQL/read rows carry `Id`. Absent = the create response
   *  carries the same `remote.id` field as record reads. Consumed
   *  ONLY by the write executor's create dispatch to extract the new
   *  record's vendor-native id; projection, compare, and the vendor-
   *  truth stamp keep reading `id` (a create response that isn't a
   *  full record simply yields no stamp — the first sync cycle
   *  rewrites the row). Without it a vendor whose create response
   *  lacks the read-shape id field would report a SUCCESSFUL create as
   *  an extraction failure, skip the local write, and invite duplicate
   *  vendor records on retry. */
  create_response_id_field?: string;
  version: WorkEntitySourceRemoteVersion;
  /** Fields folded into `source_record_hash` for change suppression /
   *  conflict detection. */
  hash_fields: string[];
}

/** Op-slot → catalog operation key (a key of `surfaces.api.executes`).
 *  `null` / absent = the slot is not supported by this Source. */
export type WorkEntitySourceOps = Partial<Record<WorkEntityOpSlot, string | null>>;

/** The op slots that target ONE remote record and therefore need an
 *  id-arg binding (`list` walks a collection; `create` has no id yet). */
export const WORK_ENTITY_TARGETED_OP_SLOTS = ['read', 'update', 'delete', 'complete'] as const;
export type WorkEntityTargetedOpSlot = (typeof WORK_ENTITY_TARGETED_OP_SLOTS)[number];

/** D-192 P4 — how the executor passes the vendor-native record id into
 *  a targeted op's args. A catalog operation's arg names are wire-level
 *  (path-template tokens, query keys, body fields) and vendor-specific
 *  — the declaration must NAME the arg; the substrate never guesses.
 *  A declared targeted op WITHOUT a binding is list-syncable but not
 *  remotely readable/writable: the executor records a `config` outcome
 *  (the sync runner's graceful config-fail posture) until the author
 *  adds the binding. */
export interface WorkEntitySourceOpBinding {
  /** The op argument (dot-path into the op's args) that carries the
   *  vendor-native record id — e.g. `taskId` for a
   *  `crm/v3/objects/tasks/{taskId}` path template. */
  id_arg: string;
  /** D-192 P4b — the op argument carrying the conditional-write
   *  precondition token (`source_version_token`) when the declaration's
   *  `write_policy.conditional_write` is not `'none'`. A connection-api
   *  wire key like the id_arg: `header.If-Match` for an etag vendor, a
   *  body/query field for a revision counter. Write-slot bindings
   *  (`update` / `complete` / `delete`) only — a read carries no
   *  precondition. */
  precondition_arg?: string;
}

/** Per-slot bindings for the targeted ops (spec § Write policy — the
 *  P4 read-before-write / conditional-write executor consumes these). */
export type WorkEntitySourceOpBindings =
  Partial<Record<WorkEntityTargetedOpSlot, WorkEntitySourceOpBinding>>;

export interface WorkEntitySourceCursor {
  kind: WorkEntityCursorKind;
  /** The list-op argument the watermark is passed through. */
  arg: string;
  /** The remote field the watermark is derived from. */
  remote_field: string;
}

export interface WorkEntitySourceSync {
  /** Omitted = `records` (the existing mirrored behavior).
   *  `read_through` schedules no poller and persists no `data_<kind>` row;
   *  generic reads invoke `ops.list` / `ops.read` and return transient
   *  Source-qualified entities. */
  posture?: WorkEntitySourcePosture;
  mode: WorkEntitySyncMode;
  depth: WorkEntitySyncDepth;
  cursor?: WorkEntitySourceCursor;
  /** D-192 CORE #8b — what a list-op row carries. Absent = `'record'`
   *  (the row is the record — every shipped vendor before Azure
   *  DevOps). `'reference'` = identity-only rows; the sync walk
   *  hydrates each through the read op before projection (see
   *  `WORK_ENTITY_LIST_ROW_KINDS`). Requires `op_bindings.read.id_arg`
   *  (validator-gated — hydration cannot name the vendor record
   *  without it). */
  list_rows?: WorkEntityListRowKind;
  /** Mirror-only. Required for `records`; forbidden for `read_through`. */
  tombstones?: WorkEntityTombstoneKind;
  /** Required with `tombstones: 'native'` (P3 fold): the remote field
   *  whose truthy value marks a vendor-side deletion/archival on a
   *  fetched row (Google Tasks `deleted`, HubSpot `archived`). Without
   *  a declared field the sync runner cannot read the vendor's
   *  tombstone — 'native' would be unimplementable prose. */
  tombstone_field?: string;
  /** Required with `tombstones: 'missing_means_deleted'` — must be
   *  `'complete_authoritative'` there. */
  list_scope?: WorkEntityListScope;
  /** Mirror-only. Required for `records`; forbidden for `read_through`. */
  stale_after_ms?: number;
}

export interface WorkEntitySourceWildQueryPolicy {
  remote_fanout: 'bounded_targeted';
  max_sources: number;
  max_remote_records: number;
  on_exceeds_cap: 'ask_to_narrow';
}

/** Read-time freshness verdict for one registered Source (spec § Read
 *  resolution policy — "poll is the freshness baseline"). Computed from
 *  the Source's `work_entity_source_sync_state` row; surfaced VERBATIM
 *  in read-result metadata (the D-190 `truncated`/`pages_fetched`
 *  honesty precedent) so no consumer answers confidently from stale
 *  rows.
 *
 *  - `local` — a non-connection Source (Recued built-in): the rows ARE
 *    the source of truth; no staleness axis exists.
 *  - `fresh` — last successful sync within the declared
 *    `stale_after_ms`.
 *  - `stale` — last success older than `stale_after_ms` (a warm mirror
 *    can be a full poll cycle behind the vendor).
 *  - `degraded` — the last cycle failed a row or the fetch itself
 *    failed; treated as stale REGARDLESS of `last_success_at`.
 *  - `never_synced` — no successful cycle yet (just enrolled, config
 *    failure, or the sync substrate predates the row). */
export const WORK_ENTITY_SOURCE_FRESHNESS_STATES = [
  'local', 'read_through', 'fresh', 'stale', 'degraded', 'never_synced',
] as const;
export type WorkEntitySourceFreshnessState =
  (typeof WORK_ENTITY_SOURCE_FRESHNESS_STATES)[number];

/** One Source's freshness, as carried on read-result metadata. The
 *  sync-detail fields are present for connection Sources only —
 *  `local` has no sync cycle to report. */
export interface WorkEntitySourceFreshness {
  source_id: string;
  state: WorkEntitySourceFreshnessState;
  /** Last successful sync-cycle completion (ms epoch); null = never. */
  last_success_at?: number | null;
  /** The declaration's staleness horizon the verdict was computed
   *  against. */
  stale_after_ms?: number;
  /** The last cycle's error code when the Source is degraded
   *  (`fetch_<kind>` / `projection_failed` / `rows_unkeyed` /
   *  `config`). */
  last_error_code?: string | null;
  /** D-192 CORE #8f — present as `false` ONLY when the last successful cycle
   *  covered a PARTIAL list (a Source list op with no `pagination` mirrors the
   *  first page only, or a paginated walk truncated). A DISTINCT axis from the
   *  `state`: a Source can be `fresh` yet `list_complete: false` — the mirror
   *  is timely but may not cover the whole list. ABSENT means complete (the
   *  common case) — mirroring the conditional `last_error_code`; never present
   *  as `true`, and omitted for `local`/`never_synced` (no completed cycle). */
  list_complete?: false;
}

export interface WorkEntitySourceReadResolution {
  /** `local_rich_meta` pairs with mirrored `records`; `source` pairs with
   *  `read_through` and means the declared operation is the read baseline. */
  default: 'local_rich_meta' | 'source';
  /** Mirror escalation policy. Omitted for `read_through`, whose baseline is
   *  already the source. */
  remote_when?: WorkEntityRemoteWhenReason[];
  wild_query: WorkEntitySourceWildQueryPolicy;
}

export interface WorkEntitySourcePreviewField {
  /** Remote source field path. */
  field: string;
  /** Bounded; defaults to `WORK_ENTITY_PREVIEW_DEFAULT_MAX_CHARS`,
   *  hard-capped at `WORK_ENTITY_PREVIEW_HARD_MAX_CHARS`. */
  max_chars?: number;
}

/** D-192 CORE #8c/#8e — closed derivation kinds for the object form of
 *  a `projection.canonical` value. No expressions, no ranges, no AI —
 *  the projection lane's closed-derivation posture; each kind is one
 *  deterministic, reviewable shape.
 *  - `number_equals` (CORE #8c) — the numeric-completion class: the
 *    remote field parses as a number (same digit-string tolerance as
 *    the `progress` coercion) and the canonical BOOLEAN is strict
 *    equality against the declared comparand (Planner `done` =
 *    `percentComplete == 100`).
 *  - `transform` (CORE #8e) — the projection-derive class: run one
 *    whitelisted pure transform (`WORK_ENTITY_CANONICAL_TRANSFORM_FNS`)
 *    over a remote text path, deriving a canonical STRING (Confluence
 *    `title ← strip_html(body.storage.value)` — an inline task carries
 *    no title field, only an XHTML body). */
export const WORK_ENTITY_CANONICAL_DERIVE_KINDS = ['number_equals', 'transform'] as const;
export type WorkEntityCanonicalDeriveKind = (typeof WORK_ENTITY_CANONICAL_DERIVE_KINDS)[number];

/** D-192 CORE #8e — the closed whitelist of pure transforms a
 *  `transform` derivation may run in the projection lane. v1:
 *  `strip_html` only (already a recipe-usable transform; this item is
 *  the projection-layer wiring). Deliberately NOT the full transform
 *  registry: the projection lane admits only single-input,
 *  deterministic, string→string transforms — no options, no context,
 *  no expressions. Grows per verified vendor need (Notion rich-text
 *  concat is the known next candidate), same posture as
 *  `WORK_ENTITY_CANONICAL_DERIVE_KINDS`. */
export const WORK_ENTITY_CANONICAL_TRANSFORM_FNS = ['strip_html'] as const;
export type WorkEntityCanonicalTransformFn = (typeof WORK_ENTITY_CANONICAL_TRANSFORM_FNS)[number];

/** CORE #8c — the `number_equals` derivation: remote numeric → canonical
 *  boolean by strict equality. Row semantics: absent remote value → the
 *  canonical field is absent (the row-level required-signal checks still
 *  apply); non-numeric value → row failure (honest beats defaulted);
 *  numeric → strict equality yields the boolean, so an incomplete task
 *  projects a REAL `done: false`, never undefined. */
export interface WorkEntityCanonicalNumberEquals {
  kind: 'number_equals';
  /** Remote source field path the derivation reads. */
  field: string;
  /** The comparand — a finite number (Planner: `100`). */
  value: number;
}

/** CORE #8e — the `transform` derivation: run one whitelisted pure
 *  transform over a remote text path to derive a canonical string. Row
 *  semantics: absent remote value → the canonical field is absent (the
 *  row-level required checks still apply — an empty stripped result is
 *  absent too, so an all-markup body fails a required title loud); a
 *  present NON-string value → row failure (an HTML transform over
 *  `[object Object]` would fabricate a garbage title — honest beats
 *  defaulted); a string → the transform output coerces through the
 *  field's OWN closed coercion (the title cap still applies), so a
 *  transform can never widen what the field admits. */
export interface WorkEntityCanonicalTransformDerivation {
  kind: 'transform';
  /** Remote source field path the transform reads (the HTML body). */
  field: string;
  /** One of `WORK_ENTITY_CANONICAL_TRANSFORM_FNS`. */
  transform: WorkEntityCanonicalTransformFn;
}

/** One declared canonical derivation — the object form of a
 *  `projection.canonical` value (a discriminated union on `kind`). Only
 *  fields in the kind's applicability set may carry one (validator-
 *  gated: `WORK_ENTITY_SOURCE_DERIVABLE_CANONICAL` for `number_equals`,
 *  `WORK_ENTITY_SOURCE_TRANSFORMABLE_CANONICAL` for `transform`), and a
 *  derived field may NOT be writable: it has no single vendor read path
 *  for the write executor's patch-target fallback, and no closed inverse
 *  exists in v1. */
export type WorkEntityCanonicalDerivation =
  | WorkEntityCanonicalNumberEquals
  | WorkEntityCanonicalTransformDerivation;

export interface WorkEntitySourceProjection {
  /** Canonical column ← remote field path; or — for the closed
   *  coalescable fields (`WORK_ENTITY_SOURCE_COALESCABLE_CANONICAL`,
   *  D-192 CORE #8d) — an ordered ARRAY of ≥ 2 remote field paths
   *  (first usable wins); or — for the closed derivable fields — a
   *  declared `WorkEntityCanonicalDerivation` object: `number_equals`
   *  on `WORK_ENTITY_SOURCE_DERIVABLE_CANONICAL` (CORE #8c) or a
   *  `transform` on `WORK_ENTITY_SOURCE_TRANSFORMABLE_CANONICAL`
   *  (CORE #8e). Keys are closed per kind
   *  (`WORK_ENTITY_SOURCE_CANONICAL_FIELDS`). */
  canonical: Record<string, string | string[] | WorkEntityCanonicalDerivation>;
  /** Bounded text derived from longer remote fields — never a complete
   *  body. Non-empty preview requires the `detail_fidelity: 'preview'`
   *  marker in `extension`. */
  preview?: Record<string, WorkEntitySourcePreviewField>;
  /** Declared bounded vendor hints (display/routing) — never a raw
   *  vendor dump. Values are remote field PATHS or literal markers —
   *  what the projected ROW may hold at runtime (bounded scalars or
   *  small arrays, per the `WORK_ENTITY_EXTENSION_*` caps) is the P3
   *  projection gate's concern, not the declaration's. The
   *  `detail_fidelity` key is special: `'preview'` (marks every
   *  preview-lane field) or a per-field map `{ body: 'preview' }`
   *  covering every declared preview key (spec § Sync depth shows the
   *  map form; the Contract-shape fragment shows the scalar — both are
   *  valid). */
  extension?: Record<string, string | Record<string, string>>;
}

export interface WorkEntitySourceRelationship {
  /** One of `WORK_ENTITY_SOURCE_RELATIONSHIP_LOCAL_FIELDS[kind]`. */
  local_field: string;
  remote_field: string;
  target: WorkEntityRelationshipTarget;
  /** Remote entity the reference points at (required for
   *  `pairing: 'remote_id'`). */
  remote_entity?: string;
  pairing: WorkEntityPairingMode;
  /** Required for `pairing: 'lookup'`; forbidden otherwise. */
  lookup_key?: WorkEntityLookupKey;
  cardinality: 'one' | 'many';
  /** v1: must be `false` (fail-closed — spec § Identity and
   *  relationships; a stricter validator gates any future opt-in). */
  write_back: boolean;
}

/** D-192 — the write-policy knobs a Source may actually DECLARE.
 *
 *  `read_before_write` and `post_write_verify` were RETIRED (2026-07-14): both
 *  were unbacked. Neither had a single runtime consumer — the validator merely
 *  forced `read_before_write` to `true` (a field whose entire contract was "you
 *  must write `true` here") and forced `post_write_verify` to `true` for an
 *  unconditional write, while the engine performed BOTH steps unconditionally
 *  regardless of what the declaration said. A flag that cannot change behaviour
 *  is not a policy; it is a promise nothing keeps, and the validator's own error
 *  text claimed they "carry the safety" while nothing read them.
 *
 *  The behaviours themselves are unconditional and now genuinely enforced: the
 *  mandatory preflight read (`dispatchWrite` step 2) and the ASSERTING post-write
 *  verify (`unlandedPushedFields`, which fails a write the vendor never applied
 *  instead of folding its stale value over the user's edit). Safety by
 *  construction, not by a boolean a pack could have lied about. */
export interface WorkEntitySourceWritePolicy {
  conditional_write: WorkEntityConditionalWriteKind;
  stale_write: WorkEntityConflictResolution;
  field_conflicts: WorkEntityConflictResolution;
}

/** Canonical fields the projector coerces through `coerceDateMs` —
 *  ms-epoch numbers locally. The only fields a `date_format` write
 *  transform may target (and which a `vocab` transform may not). */
export const WORK_ENTITY_DATE_CANONICAL_FIELDS = [
  'due_at', 'completed_at', 'target_completion_at',
] as const;

export const WORK_ENTITY_WRITE_TRANSFORM_KINDS = ['vocab', 'date_format'] as const;
export type WorkEntityWriteTransformKind = (typeof WORK_ENTITY_WRITE_TRANSFORM_KINDS)[number];

/** Closed output formats for a `date_format` write transform. Grows
 *  per verified vendor need — `'yyyy-MM-dd'` is Salesforce's `date`
 *  field wire shape (the REST JSON deserializer takes date STRINGS
 *  and rejects numbers). */
export const WORK_ENTITY_WRITE_DATE_FORMATS = ['yyyy-MM-dd'] as const;
export type WorkEntityWriteDateFormat = (typeof WORK_ENTITY_WRITE_DATE_FORMATS)[number];

/** Closed-vocabulary inverse mapping: canonical value → the vendor's
 *  wire value (`medium` → Salesforce `Normal` / HubSpot `MEDIUM`).
 *  When the writable field's CANONICAL domain is itself closed (task
 *  `priority`, project `state`), the map must cover that domain
 *  exactly — a partial map would turn user-selectable values into
 *  write refusals, and an extra key is dead config. An unmapped value
 *  at runtime config-refuses BEFORE any side effect (never a verbatim
 *  fallback — the silent-broken-push this substrate exists to
 *  prevent). */
export interface WorkEntityWriteVocabTransform {
  kind: 'vocab';
  map: Record<string, string>;
}

/** Typed derivation: the canonical ms-epoch number → a vendor date
 *  string in the declared closed format. */
export interface WorkEntityWriteDateFormatTransform {
  kind: 'date_format';
  format: WorkEntityWriteDateFormat;
}

/** One declared inverse WRITE transform for a writable field. The
 *  projector's forward coercions are lossy (vendor `Normal` →
 *  canonical `medium`; `'2026-07-15'` → ms-epoch) and the write
 *  executor pushes patch values verbatim — a field whose forward map
 *  has no verbatim inverse is unwritable WITHOUT one of these (the
 *  hb/sf make-live slices dropped `priority`/`due_at` for exactly
 *  this). Closed kinds, no expression language — same posture as the
 *  projection lane's closed derivation set. Applied at `prepare` (the
 *  wire value rides next to the canonical value; conflict comparison
 *  stays canonical). */
export type WorkEntityWriteTransform =
  | WorkEntityWriteVocabTransform
  | WorkEntityWriteDateFormatTransform;

/** D-192 — a vendor op arg resolved from a declared source rather than a
 *  canonical work-entity field. Two sources:
 *   - `connection_config` — a key in the bound connection's config (a
 *     per-connection value set at enrollment; Asana `workspace`, Google Tasks
 *     `tasklist`, jira `cloud_id`). Resolved against the connection config at
 *     dispatch; a bound-but-unset key fails resolution (the caller degrades /
 *     config-refuses).
 *   - `static` — a CONSTANT baked into the declaration, never per-connection
 *     and never user-set. D-192 Zoho CRM Tasks: the generic record ops
 *     (`GET /{module}` / `GET /{module}/{recordID}`) path-prove against the
 *     pinned OAS's `/{module}` path, and the Source scopes them to a fixed
 *     `module='Tasks'` the pack KNOWS — binding it from `connection_config`
 *     would make the user set a constant on a connection that serves every
 *     module. Always resolves.
 *  Two consumers share this shape:
 *   - `create_arg_bindings` — a create-required arg (Linear `issue.create` needs
 *     a `teamId` the canonical task model has no column for);
 *   - `op_arg_bindings` — a SCOPING arg the LIST walk / targeted READ needs
 *     (Asana `workspace`, Google Tasks `tasklist`, Zoho `module`).
 *  The executor resolves the value and merges it as a flat op arg (a graphql
 *  variable / a REST path or query arg). */
export type WorkEntityConfigArgBinding =
  | {
      source: 'connection_config';
      /** The key in the connection's config the value is read from. */
      config_key: string;
    }
  | {
      source: 'static';
      /** The constant value baked into the declaration (non-empty). */
      value: string;
    };

/** @deprecated historical name (create-only). Use `WorkEntityConfigArgBinding`
 *  — the same shape now also backs `op_arg_bindings`. */
export type WorkEntityCreateArgBinding = WorkEntityConfigArgBinding;

// ────────────────────────────────────────────────────────────────
// Source dependencies (D-192 — `create_if_not_picked`)
// ────────────────────────────────────────────────────────────────
//
// The INPUT-side analog of `relationships` (which are OUTPUT edges): what an op
// needs UPSTREAM to run — a vendor CONTAINER entity Recued does not model (Asana
// `workspace`, Linear `team`, a `project`). Resolved to one selected entity
// `{id, label}` by `create_if_not_picked`: pick from `list_op` (auto when the
// list is a single option, label-matched when the caller named it), or — where a
// `create_op` exists AND the write is authorized — create one. Nested containers
// (workspace → project → task) chain via `arg_from`, resolved top-down. See
// D-192.

/** Where a dependency's RESOLVED id flows — the op arg it scopes (`list`) or
 *  attributes (`create`). Self-contained: for the container-entity case this
 *  SUPERSEDES `op_arg_bindings` (which stays for genuinely-static per-connection
 *  config only). */
export interface WorkEntitySourceDependencyBind {
  /** The op slot the resolved id flows into — `list` scopes the sync walk,
   *  `create` attributes the new record. */
  op: WorkEntityOpSlot;
  /** The target op's arg key (a path token like `query.workspace`, or a create
   *  arg like `teamId`). For a REST body attribute the key is the FULL nested
   *  wire path (`body.data.workspace`), composed into the request body tree by the
   *  write executor / dependency resolver. */
  arg: string;
  /** Wrap the resolved id in a single-element array before it flows into `arg`.
   *  For a vendor arg that is array-typed even when one id is supplied (Asana
   *  `task.create` takes `body.data.projects: [gid]`). Absent = the scalar id
   *  flows verbatim. */
  wrap_array?: boolean;
}

/** Parent-context chain — an EARLIER dependency's selected id feeds THIS
 *  dependency's `list_op` / `create_op` (Asana projects live inside a workspace,
 *  so the project list is scoped by the chosen workspace). Resolved top-down; a
 *  forward or cyclic `dependency` ref fails validation. */
export interface WorkEntitySourceDependencyArgFrom {
  /** An earlier dependency's `ref`. */
  dependency: string;
  /** The `list_op` arg the parent's selected id fills (scopes the choice list —
   *  Asana `project.search` takes the workspace as `query.workspace`). */
  arg: string;
  /** The `create_op` arg the parent's selected id fills, WHEN it differs from the
   *  list op's `arg`. A vendor's list and create ops often name the same parent
   *  under different wire keys — a project list scoped by `query.workspace` whose
   *  create takes a `workspace_id` variable. Absent = the create op uses the same
   *  `arg` key. Only meaningful on a dependency with a `create_op`. */
  create_arg?: string;
}

/** How a dependency is resolved:
 *  - `persist` — a sync list-SCOPE selection stored per Source (headless sync
 *    cannot prompt; the value is set once at setup and reused every cycle);
 *  - `prompt` — resolved at op time (create-assist: fetch the list live, pick or
 *    create, one batched write-confirm). */
export const WORK_ENTITY_DEPENDENCY_RESOLVE_MODES = ['persist', 'prompt'] as const;
export type WorkEntityDependencyResolveMode = (typeof WORK_ENTITY_DEPENDENCY_RESOLVE_MODES)[number];

/** One input dependency on an unmodeled vendor container entity. */
export interface WorkEntitySourceDependency {
  /** Logical name, UNIQUE within the declaration — the resolution key + the
   *  `arg_from` reference target (`'workspace' | 'team' | 'project' | …`). */
  ref: string;
  /** Catalog op key that LISTS the choices (read). Bare-callable, or arg-driven
   *  via `arg_from`. */
  list_op: string;
  /** Path to the entity's vendor-native id in a list row. */
  id_field: string;
  /** Path to the entity's display label in a list row. */
  label_field: string;
  /** Catalog op key that CREATES one (write). Absent = pick-only: the resolver
   *  never offers "＋ new" and auto-selects a lone option. */
  create_op?: string;
  /** The `create_op` arg carrying the new entity's name. Required with
   *  `create_op` (a create the substrate cannot name is unusable). */
  create_name_arg?: string;
  /** Parent-context chain (top-down; no cycles). */
  arg_from?: WorkEntitySourceDependencyArgFrom[];
  /** Where the resolved id flows (≥1). One container may bind several ops (a
   *  workspace scopes the list AND attributes a create). */
  binds: WorkEntitySourceDependencyBind[];
  resolve: WorkEntityDependencyResolveMode;
}

/** One declared Source: one remote entity collection → one Recued work
 *  entity kind. */
export interface WorkEntitySourceDeclaration {
  kind: WorkEntitySourceDeclarableKind;
  /** Must contain `${connection_id}` (no cross-connection collision)
   *  and end with `.<kind>` (the Source id names its entity kind) —
   *  the `CONNECTION_SOURCE_ID` format, e.g.
   *  `salesforce.${connection_id}.task`. */
  source_id_template: string;
  source_label_template?: string;
  /** v1: pack declarations are connection-derived Sources only. */
  source_kind: 'connection';
  /** AMENDED — D-192 authority ladder, ratified 2026-07-14 (was REQUIRED).
   *
   *  PRESENT ⇒ a machine-provable schema doc exists; the publish op-prover
   *  runs exactly as it always has (pin-equality against the catalog's
   *  `surfaces.api.<kind>_source` still enforced, byte-for-byte).
   *
   *  ABSENT ⇒ there is no *documentary* op proof, and that is legal. The
   *  Source proves its ops EMPIRICALLY instead — a live smoke against a real
   *  connection (ladder §6), which is STRONGER than a doc proof, not weaker:
   *  a document asserts an endpoint SHOULD exist; a live call proves it DOES.
   *
   *  ⛔ The evidence for either route lives in the AUTHORING DOCUMENT
   *  (`docs/sources/<slug>-<kind>.md`), NEVER here and never anywhere else in
   *  the pack (ladder §3.1): a schema field lossily compresses the caveats,
   *  has no runtime consumer, and — self-asserted and unverifiable — would be
   *  a lie surface inside a trust-bearing artifact.
   *
   *  ⚠ Absence is NOT a capability signal. Contract + approval govern reads
   *  and writes at every rung (ladder §8.1) — an unpinned Source is not
   *  read-only, not second-class, and not fenced. The kernel has run three
   *  unpinned Sources (hubspot note, salesforce task, microsoft task) for
   *  months; this generalises that working posture to packs. */
  contract_source?: WorkEntitySourceContractSource;
  remote: WorkEntitySourceRemote;
  ops: WorkEntitySourceOps;
  /** D-192 P4 — id-arg bindings for the targeted ops. Optional at the
   *  declaration level (a list-only Source needs none); the executor
   *  config-fails a targeted invocation whose slot lacks a binding. */
  op_bindings?: WorkEntitySourceOpBindings;
  /** D-192 — NON-id op args resolved from the bound connection's config, for the
   *  LIST walk and the targeted READ. The general case of `create_arg_bindings`:
   *  a per-connection SCOPING value the canonical model has no column for and the
   *  sync runner cannot guess — Asana `GET /tasks` needs a `workspace`, Google
   *  Tasks `/lists/{tasklist}/tasks` needs a `tasklist`. Keyed by op slot
   *  (`list` | `read` | `update` | `delete` | `complete`), then by the op's OWN arg key (a path token like
   *  `tasklist_id`, or a `query.*` key). Resolved against the connection config at
   *  dispatch; a bound-but-unset key degrades the sync cycle / config-fails the
   *  targeted operation BEFORE the call — never a silent bad request. The record
   *  id still rides `op_bindings.<slot>.id_arg`; these are the OTHER args. Create
   *  remains separate because it has no targeted id and already uses
   *  `create_arg_bindings`. */
  op_arg_bindings?: Partial<Record<
    'list' | 'read' | 'update' | 'delete' | 'complete',
    Record<string, WorkEntityConfigArgBinding>
  >>;
  /** D-192 — INPUT dependencies on unmodeled vendor container entities (Asana
   *  `workspace`, Linear `team`, a `project`) that gate the list scope / create.
   *  Each is resolved to one selected entity by `create_if_not_picked` and its id
   *  flows into the declared `binds`. Supersedes `op_arg_bindings` for the entity
   *  case (a live, user-selected value — not static config). See
   *  D-192. */
  source_dependencies?: WorkEntitySourceDependency[];
  sync: WorkEntitySourceSync;
  read_resolution: WorkEntitySourceReadResolution;
  projection: WorkEntitySourceProjection;
  /** Subset of the kind's canonical allowlist ∪ declared preview
   *  fields (a preview-lane write is a remote-detail write protected by
   *  read-before-write). Requires `sync.mode: 'read_write'`. */
  writable_fields?: string[];
  /** Inverse write transforms, keyed by writable field. Required for
   *  any writable field whose forward projection is lossy (closed
   *  vendor vocabularies, non-epoch date wires); fields that round-trip
   *  verbatim declare none. Keys must be ⊆ `writable_fields`. */
  write_transforms?: Record<string, WorkEntityWriteTransform>;
  /** D-192 write-path mapping — per writable field, the vendor WRITE
   *  target when it differs from the projection READ path. The write
   *  executor composes the narrow patch at `write_paths[field]` when
   *  present, else falls back to the field's projection lane path
   *  (canonical column ← remote path, or the preview field path).
   *  Needed when a vendor's read response shape ≠ its write request
   *  shape (Todoist reads `due.date` but writes flat `due_date`;
   *  HubSpot/Salesforce read and write the same `properties.*` path, so
   *  they declare none). For a graphql op the path is the mutation
   *  VARIABLE name (flat) — the executor sends the pushable as the
   *  graphql `variables` object; for a REST op it is the (possibly
   *  nested) request-body path. Keys must be ⊆ `writable_fields`. */
  write_paths?: Record<string, string>;
  /** Canonical/preview fields the VENDOR requires on a create (e.g.
   *  HubSpot task create rejects without `hs_timestamp` → `due_at`).
   *  The write executor's `prepare` config-refuses a create missing one
   *  BEFORE any side effect — a vendor-first create that 400s would
   *  otherwise lose the row entirely (no local write has happened yet).
   *  Must be a subset of `writable_fields` (a required create field the
   *  declaration cannot push is unsatisfiable). */
  create_required_fields?: string[];
  /** D-192 — vendor op args a create needs that are NOT canonical fields (Linear
   *  `issue.create` requires a `teamId`), keyed by the op's arg name. Resolved
   *  from the declared source at `prepare`; the write executor config-refuses a
   *  create BEFORE any side effect when a bound value is absent. Create-only —
   *  requires an `ops.create`. */
  create_arg_bindings?: Record<string, WorkEntityConfigArgBinding>;
  relationships?: WorkEntitySourceRelationship[];
  /** Required iff `sync.mode` is `'read_write'`. */
  write_policy?: WorkEntitySourceWritePolicy;
}
