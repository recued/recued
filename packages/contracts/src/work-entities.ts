/** D-145 PA1 — Canonical work entity shapes (`task` / `note` /
 *  `commitment` / `project`).
 *
 *  Per D-145 § A.1. Four new top_tier_kinds shipped as substrate. Each
 *  carries a uniform Source-row-identity column set per § A.1.6 so
 *  polymorphic `data.<kind>.*` reads stay trustworthy when multiple
 *  Sources contribute (Recued built-in + HubSpot + Salesforce + future
 *  adapters). `lifecycle_state` × `due_status` for `commitment` follows
 *  the orthogonal-axes model — § A.1.3 explicitly retired the prior
 *  flat `state` enum's `expired_without_action` terminal because
 *  monetary commitments must NOT silently expire when the deadline
 *  passes. PA1 lays only the type system + storage tables; resolver +
 *  CRUD ingredients + reactive triggers come in PA2-PA4.
 *
 *  Spec: D-145 § A.1. */

// ────────────────────────────────────────────────────────────────
// Top-tier kinds
// ────────────────────────────────────────────────────────────────

export const WORK_ENTITY_KINDS = [
  'task',
  'note',
  'commitment',
  'project',
  // D-210 — the mutable business entity a reservation needs. See the
  // `booking` section below for why it is not a `commitment` and not a
  // discriminator on the calendar table.
  'booking',
] as const;
export type WorkEntityKind = (typeof WORK_ENTITY_KINDS)[number];

export const WORK_ENTITY_KIND_SET: ReadonlySet<WorkEntityKind> = new Set(WORK_ENTITY_KINDS);

export const isWorkEntityKind = (v: unknown): v is WorkEntityKind =>
  typeof v === 'string' && WORK_ENTITY_KIND_SET.has(v as WorkEntityKind);

// ────────────────────────────────────────────────────────────────
// Source row identity — common to every work entity (§ A.1.6)
// ────────────────────────────────────────────────────────────────

export const SYNC_STATES = ['live', 'stale_unreachable', 'tombstoned', 'orphaned'] as const;
export type SyncState = (typeof SYNC_STATES)[number];
export const SYNC_STATE_SET: ReadonlySet<SyncState> = new Set(SYNC_STATES);

export const CONFLICT_POLICIES = ['source_wins', 'recued_wins', 'manual_merge'] as const;
export type ConflictPolicy = (typeof CONFLICT_POLICIES)[number];
export const CONFLICT_POLICY_SET: ReadonlySet<ConflictPolicy> = new Set(CONFLICT_POLICIES);

/** D-192 P4 — the row's Recued-originated dirty-write state (spec
 *  § Conflict model: "Recued-originated writes should be modeled as a
 *  temporary dirty-write state, not as a permanent row label"). Staged
 *  when a local edit targets an external Source; cleared on vendor
 *  acknowledgement / post-write verification. The BASE fields capture
 *  the source version AT EDIT TIME — the conflict detector compares
 *  the vendor's current version against these, never wall-clock. */
export interface WorkEntityPendingWrite {
  /** When the local edit was staged (ms epoch). */
  staged_at: number;
  operation: 'create' | 'update' | 'delete' | 'complete';
  /** Field-level dirty set — canonical field names the local edit
   *  touched (drives disjoint-field merge vs `manual_merge`). */
  dirty_fields: string[];
  /** Source version captured at edit time. */
  base_source_updated_at?: number | null;
  base_source_record_hash?: string | null;
  base_source_version_token?: string | null;
  /** `pending` — staged, vendor write not yet acknowledged.
   *  `awaiting_verify` — vendor write dispatched, post-write
   *  verification outstanding. */
  state: 'pending' | 'awaiting_verify';
  /** Dispatch attempts so far (retry bookkeeping). */
  attempts?: number;
}

/** Common Source-row-identity columns. Every work entity table
 *  carries this set verbatim per § A.1.6 — `source_id` is required at
 *  insert time (Recued built-in is the default Source for new rows in
 *  PA2). `source_record_id` is NULL for Recued built-in rows, populated
 *  with the vendor-native id for connection-derived rows. `last_seen_at`
 *  is updated on every reconciliation cycle hit. `deleted_at` is the
 *  tombstone — set when the source-side delete is observed; the row
 *  stays so cascade history + audit references resolve.
 *
 *  D-192 P4 additions: `source_version_token` — the vendor's version
 *  value VERBATIM (etag / revision / content-hash / raw timestamp
 *  string), the conditional-write precondition token; distinct from
 *  `source_updated_at`, which is the COERCED ms timestamp for
 *  freshness ordering. `pending_write` — the row's dirty-write state;
 *  never written by sync (a poll upsert must not silently clear a
 *  staged local edit — the P4 write executor owns its lifecycle). */
export interface SourceRowIdentity {
  source_id: string;
  source_record_id?: string;
  connection_id?: string;
  source_updated_at?: number;
  last_seen_at: number;
  deleted_at?: number;
  sync_state: SyncState;
  conflict_policy: ConflictPolicy;
  source_record_hash?: string;
  source_version_token?: string;
  pending_write?: WorkEntityPendingWrite;
}

/* ⛔ `SOURCE_DEFAULT_PREFS_KEY` (`<kind>.last_used_source_id`) was DELETED with
 *  the per-kind default Source (D-187 Sources half, D-187 § 11).
 *  It had ZERO production consumers, and the name was a standing lie: nothing
 *  ever wrote it on use — the create path never called `setDefaultSource`, so
 *  "last used" was only ever an explicit pin from a Settings page that no
 *  longer exists. Write routing is now `explicit source_id ?? built-in local`. */

// ────────────────────────────────────────────────────────────────
// task (§ A.1.1)
// ────────────────────────────────────────────────────────────────

export const TASK_PRIORITIES = ['low', 'medium', 'high'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export const TASK_PRIORITY_SET: ReadonlySet<TaskPriority> = new Set(TASK_PRIORITIES);

export const TASK_TITLE_MAX = 200;

/** Optional create idempotency is deliberately namespaced and ASCII-only so
 * the derived local task id remains URL/log safe. The key is caller-owned
 * business identity (for example one workflow + submission), never task copy. */
export const TASK_IDEMPOTENCY_KEY_MAX = 180;
export const TASK_IDEMPOTENCY_ID_PREFIX = 'task-idempotent-' as const;

const TASK_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

export const isTaskIdempotencyKey = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length > 0
  && value.length <= TASK_IDEMPOTENCY_KEY_MAX
  && TASK_IDEMPOTENCY_KEY_PATTERN.test(value);

/** Stable local id for an idempotent task create. Returning null keeps invalid
 * keys out of storage rather than normalizing two caller identities together. */
export const taskIdFromIdempotencyKey = (key: string): string | null =>
  isTaskIdempotencyKey(key)
    ? `${TASK_IDEMPOTENCY_ID_PREFIX}${[...key]
        .map((character) => character.charCodeAt(0).toString(16).padStart(2, '0'))
        .join('')}`
    : null;

/** D-179 fork (a) RESOLVED — cap on the free-form `state` string. */
export const TASK_STATE_MAX = 100;

export interface Task extends SourceRowIdentity {
  id: string;
  title: string;
  body?: string;
  done: boolean;
  /** D-179 fork (a) — free-form domain state ("open" / "success" /
   *  "fail_timeout" / whatever the pipeline's vocabulary is). NO
   *  closed enum and NO transition validation by design — the
   *  queue-sweeper worked example proved vocabularies are
   *  domain-specific. `state` never auto-flips `done`: `done` stays
   *  the single completion bit (mark-done dispatcher + `completed`
   *  reactive events). Changes emit `state_changed` on the bus, same
   *  as commitment / project. */
  state?: string;
  /** D-179 fork (a) — coarse progress, integer 0–100. Pure
   *  display/inspection metadata; no semantics attached. */
  progress?: number;
  due_at?: number;
  priority?: TaskPriority;
  created_at: number;
  updated_at: number;
  completed_at?: number;
  assigned_contact_id?: string;
  parent_calendar_event_id?: string;
  linked_mail_thread_id?: string;
  parent_project_id?: string;
  /** Self-referential dependencies — task ids this task is blocked on.
   *  Stored as JSON array on the row at PA1; junction-table lift can
   *  follow if PA4 reactive triggers need indexed reverse lookup. */
  blocks_task_ids: readonly string[];
  source_extension_blob?: Record<string, unknown>;
}

// ────────────────────────────────────────────────────────────────
// note (§ A.1.2)
// ────────────────────────────────────────────────────────────────

export const NOTE_TITLE_MAX = 200;

/** Note access ledger row kind (§ A.1.2). Read-mutating canonical
 *  records is forbidden — every note read writes to a server-internal
 *  `note_access_ledger` table that the `note_relevance_decay` producer
 *  reads from. No cross-cloud sync (D-097 / D-168). Never returned via MCP. */
export const NOTE_ACCESS_KINDS = [
  'user_open',
  'user_edit',
  'recipe_query',
  'ai_packet_inclusion',
  'mcp_read',
] as const;
export type NoteAccessKind = (typeof NOTE_ACCESS_KINDS)[number];
export const NOTE_ACCESS_KIND_SET: ReadonlySet<NoteAccessKind> = new Set(NOTE_ACCESS_KINDS);

export interface Note extends SourceRowIdentity {
  id: string;
  title?: string;
  body: string;
  created_at: number;
  updated_at: number;
  /** Updated only on explicit user open / edit / save / pin / unpin —
   *  NOT on AI inclusion / recipe query / MCP read. § A.1.2 spells
   *  this out: read-mutating canonical fields distorts producer math
   *  and creates an AI-retrieval feedback loop. */
  last_user_action_at: number;
  related_contact_ids: readonly string[];
  related_calendar_event_ids: readonly string[];
  related_mail_thread_ids: readonly string[];
  related_project_ids: readonly string[];
  source_extension_blob?: Record<string, unknown>;
}

export interface NoteAccessLedgerEntry {
  id: string;
  note_id: string;
  accessed_at: number;
  access_kind: NoteAccessKind;
  access_actor?: string;
  metadata_blob?: Record<string, unknown>;
}

// ────────────────────────────────────────────────────────────────
// commitment (§ A.1.3) — load-bearing for Recued
// ────────────────────────────────────────────────────────────────

export const COMMITMENT_DIRECTIONS = ['outbound', 'inbound', 'internal'] as const;
export type CommitmentDirection = (typeof COMMITMENT_DIRECTIONS)[number];
export const COMMITMENT_DIRECTION_SET: ReadonlySet<CommitmentDirection> = new Set(
  COMMITMENT_DIRECTIONS,
);

/** Lifecycle axis — whether the work happened. Independent of
 *  deadline. § A.1.3 retired the prior `expired_without_action` flat
 *  state because conflating lifecycle + deadline silently expired
 *  monetary obligations the moment the deadline passed. */
export const COMMITMENT_LIFECYCLE_STATES = [
  'pending',
  'fulfilled',
  'cancelled',
  'expired',
] as const;
export type CommitmentLifecycleState = (typeof COMMITMENT_LIFECYCLE_STATES)[number];
export const COMMITMENT_LIFECYCLE_STATE_SET: ReadonlySet<CommitmentLifecycleState> = new Set(
  COMMITMENT_LIFECYCLE_STATES,
);

/** Deadline axis — whether the deadline has been crossed. Updates
 *  independently of lifecycle. */
export const COMMITMENT_DUE_STATUSES = [
  'not_due',
  'due_soon',
  'overdue',
  'no_deadline',
] as const;
export type CommitmentDueStatus = (typeof COMMITMENT_DUE_STATUSES)[number];
export const COMMITMENT_DUE_STATUS_SET: ReadonlySet<CommitmentDueStatus> = new Set(
  COMMITMENT_DUE_STATUSES,
);

/** Per-row deadline-crossing policy. `escalate_overdue` is the default
 *  — monetary + counterparty commitments must NOT auto-expire. */
export const COMMITMENT_EXPIRY_POLICIES = [
  'strict_expire',
  'escalate_overdue',
  'indefinite',
] as const;
export type CommitmentExpiryPolicy = (typeof COMMITMENT_EXPIRY_POLICIES)[number];
export const COMMITMENT_EXPIRY_POLICY_SET: ReadonlySet<CommitmentExpiryPolicy> = new Set(
  COMMITMENT_EXPIRY_POLICIES,
);

export const COMMITMENT_DERIVATIONS = [
  'user_declared',
  'mail_extracted',
  'meeting_extracted',
  'recipe_emitted',
  'peer_received',
  // D-192 F1 — minted from a commitment_evidence declaration's capture
  // (the approve-with-editable-args funnel). ONE value for every
  // evidence family: the evidence_blob entries' `kind` discriminates
  // the source family, so per-family enum values were rejected.
  // Derived-only — the webclient compose authoring options deliberately
  // exclude it (user-authored commitments are 'user_declared').
  'evidence_captured',
] as const;
export type CommitmentDerivation = (typeof COMMITMENT_DERIVATIONS)[number];
export const COMMITMENT_DERIVATION_SET: ReadonlySet<CommitmentDerivation> = new Set(
  COMMITMENT_DERIVATIONS,
);

export const COMMITMENT_STATEMENT_MAX = 500;

/** ISO 4217 currency-code regex. Three uppercase letters, no
 *  numeric-code variants. */
export const COMMITMENT_CURRENCY_REGEX = /^[A-Z]{3}$/;

/** Decimal-as-string regex for `monetary_value.amount`. Two-decimal
 *  precision as canonical at v1; storage flattens to
 *  `monetary_amount` + `monetary_currency` SQLite columns for indexing
 *  ergonomics. */
export const COMMITMENT_AMOUNT_REGEX = /^-?\d+(?:\.\d{1,2})?$/;

export interface MonetaryValue {
  amount: string;
  currency: string;
}

// ────────────────────────────────────────────────────────────────
// commitment evidence (D-192 F1) — the immutable capture snapshots
// an `evidence_captured` commitment binds. The DECLARATION side (a
// catalog manifest's `commitment_evidence` array) lives in
// `commitment-evidence.ts`; the ENTRY below is the canonical row
// payload persisted on `data_commitment.evidence_blob`.
// ────────────────────────────────────────────────────────────────

/** Evidence family taxonomy — one value per capture-source family, the
 *  discriminator on the `CommitmentEvidenceEntry` union below (per-family
 *  `CommitmentDerivation` values were rejected — `evidence_captured` is
 *  the ONE derivation; the entry `kind` discriminates the source). v1
 *  ships `crm_field` (the D-192 F1 CRM next-step showcase) + `mail` (the
 *  email flagship — the D-139 `commitment_tracker` extraction engine
 *  feeds proposals through the `commitment-propose` gate) + `message`
 *  (the messenger flagship — a tag/mention/content match captures the
 *  message inline as evidence at trigger time, kinds-taxonomy § 3a).
 *  `file` is deliberately NOT an evidence kind: it is a first-class
 *  SOURCE entity (a `data.file` row), related to work-entities via
 *  `data.link role:'attachment'`, never captured as commitment evidence
 *  (kinds-taxonomy § 3b; F-1=A superseded 2026-07-03). */
export const COMMITMENT_EVIDENCE_KINDS = ['crm_field', 'mail', 'message'] as const;
export type CommitmentEvidenceKind = (typeof COMMITMENT_EVIDENCE_KINDS)[number];
export const COMMITMENT_EVIDENCE_KIND_SET: ReadonlySet<CommitmentEvidenceKind> = new Set(
  COMMITMENT_EVIDENCE_KINDS,
);

/** The subset of families a *manifest* `commitment_evidence` DECLARATION
 *  may use. v1: `crm_field` only — both `mail` and `message` evidence are
 *  produced by the KERNEL (the `mail` extraction engine — the housekeeping
 *  `commitment_tracker` producer + the `commitment-propose` funnel; the
 *  `message` tag/mention/content matcher — kinds-taxonomy § 3a), never a
 *  pack-declared field diff, so no manifest declares them. The declaration
 *  validator gates on THIS set; `COMMITMENT_EVIDENCE_KINDS` is the wider
 *  set of families that can exist on a stored commitment's `evidence_blob`
 *  (mirrors F1's "v1 ships the KERNEL declaration only"). */
export const COMMITMENT_EVIDENCE_DECLARABLE_KINDS = ['crm_field'] as const;
export type CommitmentEvidenceDeclarableKind =
  (typeof COMMITMENT_EVIDENCE_DECLARABLE_KINDS)[number];
export const COMMITMENT_EVIDENCE_DECLARABLE_KIND_SET: ReadonlySet<string> = new Set(
  COMMITMENT_EVIDENCE_DECLARABLE_KINDS,
);

/** Reserved future family names — rejected by the declaration validator
 *  with a "reserved" message (mirrors the `work_entity_sources`
 *  reserved-`commitment` posture). `mail` graduated with the email
 *  flagship, `message` with the messenger flagship. EMPTY in v1: `file`
 *  was considered (F-1=A) but reclassified as a first-class SOURCE entity,
 *  not evidence (kinds-taxonomy § 3b) — the lane is retained, inert, for a
 *  genuine future evidence family. */
export const COMMITMENT_EVIDENCE_RESERVED_KINDS = [] as const;

/** Cap on a `mail`-evidence `snippet` — the LLM paraphrase of the
 *  promise, NOT a raw body excerpt (mirrors the D-139
 *  `commitment_tracker` `text` cap). Bounds the immutable snapshot and
 *  blocks body-content leakage through this slot. */
export const COMMITMENT_MAIL_EVIDENCE_SNIPPET_MAX = 200;

/** Cap on a `message`-evidence `snippet` — the captured message text. A
 *  chat message IS the evidence (captured verbatim to the cap), unlike
 *  `mail`'s LLM paraphrase; the cap still bounds the immutable snapshot.
 *  Same bound as the mail cap. */
export const COMMITMENT_MESSAGE_EVIDENCE_SNIPPET_MAX = 200;

/** Source families a `mail`-kind evidence entry may cite — the
 *  body-bearing subset of the D-139 `commitment_tracker`
 *  `aggregates_from` surface (warehouse mail / calendar / memory +
 *  per-type CRM engagement bodies; `attachment` is excluded at v1 — the
 *  promise text lives in a message/engagement, not an attachment blob).
 *  Kept a local closed list on the ENTRY so `work-entities.ts` stays
 *  free of an `enrichment-registry` import; that module's
 *  `CommitmentEvidenceSource` is the producer-side twin.
 *
 *  ⛔ `'memory'` HERE IS DELIBERATELY NOT RENAMED to match `aggregates_from`'s
 *  `'audit'` (2026-08-11) — same reason as its `CommitmentEvidenceSource` twin:
 *  this is a PERSISTED value taxonomy written into stored evidence entries, so
 *  renaming the member is a data migration, not a rename. It denotes the
 *  run-provenance trail, never `user_memory`. Change both twins or neither. */
export const COMMITMENT_MAIL_EVIDENCE_SOURCES = [
  'mail',
  'calendar',
  'memory',
  'engagement_email',
  'engagement_meeting',
  'engagement_note',
  'engagement_call',
  'engagement_task',
  'engagement_event',
  'engagement_email_message',
  'engagement_voice_call',
  'engagement_call_history',
] as const;
export type CommitmentMailEvidenceSource =
  (typeof COMMITMENT_MAIL_EVIDENCE_SOURCES)[number];
export const COMMITMENT_MAIL_EVIDENCE_SOURCE_SET: ReadonlySet<string> = new Set(
  COMMITMENT_MAIL_EVIDENCE_SOURCES,
);

/** Fields common to every immutable evidence snapshot (invariant 1: no
 *  evidence, no commitment — every `evidence_captured` commitment binds
 *  ≥ 1). Point-in-time by construction (invariant 2: capture, never
 *  mirror — a later source edit produces a NEW capture, never rewrites
 *  this one). */
export interface CommitmentEvidenceBase {
  /** Scoped source identity — for `crm_field` the D-128 per-connection
   *  `full_target_id` (`<vendor>_<entity>_<connection>_<native_id>`);
   *  for `mail` the source message / engagement `full_target_id` (or
   *  the warehouse record id for mail / calendar / memory sources). */
  full_target_id: string;
  /** Capture wall-clock (unix-ms). Also the minted commitment's
   *  `promised_at`. */
  captured_at: number;
  /** Vendor record permalink when composable at capture time. No
   *  composer helper exists at v1 — reserved, populated when one
   *  lands. Bounded like the D-139 evidence-link URL. */
  vendor_url?: string;
}

/** CRM-field capture (the D-192 F1 next-step showcase) — a deterministic
 *  diff of a canonical field on a `crm_alias` record. */
export interface CommitmentCrmFieldEvidence extends CommitmentEvidenceBase {
  kind: 'crm_field';
  /** The canonical field key the capture observed (`next_step`). */
  field: string;
  /** The as-was captured value. */
  value: string;
  /** The pre-change value when the capture event was `value_changed`;
   *  absent on `value_set` (no prior value). */
  prev_value?: string;
}

/** Mail / engagement-body capture (the email flagship) — one
 *  `TrackedCommitment.evidence_links[]` source becomes one entry: the
 *  promise the D-139 extraction engine paraphrased, bound to the source
 *  record it read. The `snippet` is the LLM paraphrase (never raw body,
 *  capped) so no body content rides the immutable snapshot. */
export interface CommitmentMailEvidence extends CommitmentEvidenceBase {
  kind: 'mail';
  /** Which source family the promise came from (body-bearing
   *  warehouse collections + per-type CRM engagement scopes). */
  source: CommitmentMailEvidenceSource;
  /** Canonical email of who made the commitment (the promise actor). */
  actor_email: string;
  /** The ≤ `COMMITMENT_MAIL_EVIDENCE_SNIPPET_MAX` LLM paraphrase of the
   *  promise — NOT a raw body excerpt. */
  snippet: string;
  /** LLM extraction confidence in [0, 1]. */
  confidence: number;
  /** When the source record was authored (unix-ms) — the `Date:`
   *  header / `start.dateTime` / engagement `vendor_modified_at`. */
  source_at: number;
}

/** Messenger capture (the messenger flagship) — a tag/mention/content
 *  match on an inbound chat message captures that message inline as
 *  evidence at trigger time (kinds-taxonomy § 3a: NO Source, NO mirror —
 *  an ambient, self-deleting stream is never stored; only the matched
 *  snapshot). The base `vendor_url` carries the message permalink when a
 *  composer supplies one. */
export interface CommitmentMessageEvidence extends CommitmentEvidenceBase {
  kind: 'message';
  /** The messenger the capture came from — the M-1 declaration's vendor
   *  slug (`slack` / `telegram` / `discord` / …). A declared chat-transport
   *  slug validated against the messenger-vendor registry
   *  (`isDeclaredMessengerVendor`). D-192 CORE #6 retired the former closed
   *  `MessengerVendor` union (`slack|telegram|email`) for wrongly including
   *  `email` (a notification channel, never a transport); the matcher only
   *  ever emits a registered vendor, so a non-empty string is the store's
   *  honest guard. */
  vendor: string;
  /** The sender's platform-native id (`ParsedInbound.from`) — opaque
   *  until the messenger→contact linker resolves it to a `contact_id`. */
  actor_platform_id: string;
  /** Resolved contact when the `(vendor, platform_id)` linker matched the
   *  sender; absent when the sender is unlinked (the owner fills at
   *  approval — the F1 nullable-counterparty posture). */
  actor_contact_id?: string;
  /** The captured message text — bounded ≤
   *  `COMMITMENT_MESSAGE_EVIDENCE_SNIPPET_MAX`. Verbatim (a chat message
   *  IS the evidence), unlike `mail`'s LLM paraphrase. */
  snippet: string;
  /** When the message was sent (unix-ms). Becomes the minted commitment's
   *  `promised_at` (mirrors `mail`'s `source_at`). */
  sent_at: number;
  /** Extraction confidence in [0, 1] — present ONLY when the capture was
   *  AI-paraphrased; a deterministic tag/mention/content match carries
   *  none (the match itself is the proof). */
  confidence?: number;
}

/** One immutable evidence snapshot — a `kind`-discriminated union across
 *  the capture families (`COMMITMENT_EVIDENCE_KINDS`). */
export type CommitmentEvidenceEntry =
  | CommitmentCrmFieldEvidence
  | CommitmentMailEvidence
  | CommitmentMessageEvidence;

/** Serialized cap for `data_commitment.evidence_blob` — the
 *  extension-lane precedent (`WORK_ENTITY_EXTENSION_BLOB_MAX_BYTES`,
 *  `work-entity-sources.ts`) applied to the evidence lane. Over-cap
 *  REFUSES the write (fail-closed; evidence must never silently
 *  truncate — a clipped snapshot is not the as-was value). */
export const COMMITMENT_EVIDENCE_BLOB_MAX_BYTES = 8 * 1024;

export interface Commitment extends SourceRowIdentity {
  id: string;
  direction: CommitmentDirection;
  statement: string;
  promised_at: number;
  promised_for_at?: number;
  lifecycle_state: CommitmentLifecycleState;
  due_status: CommitmentDueStatus;
  expiry_policy: CommitmentExpiryPolicy;
  /** Row-creation timestamp. PA3 surfaces this on the contract so the
   *  CRUD ingredient layer can preserve it across upsert-style updates
   *  without round-tripping through the SQL row. */
  created_at: number;
  /** Last write timestamp. Re-stamped by every storage upsert (PA3
   *  ingredients pass `now` explicitly so reactive triggers see a
   *  monotonically increasing `updated_at` even on no-op patches). */
  updated_at: number;
  /** Last change of EITHER axis. */
  state_changed_at: number;
  /** Last `lifecycle_state` change — populated together with
   *  `state_changed_at` when lifecycle moves. */
  lifecycle_changed_at: number;
  /** Last `due_status` change — populated together with
   *  `state_changed_at` when due moves. */
  due_status_changed_at: number;
  derivation: CommitmentDerivation;
  derivation_confidence?: number;
  monetary_value?: MonetaryValue;
  counterparty_contact_id?: string;
  derived_from_mail_thread_id?: string;
  derived_from_meeting_id?: string;
  blocks_task_ids: readonly string[];
  blocks_project_ids: readonly string[];
  source_extension_blob?: Record<string, unknown>;
  /** D-192 F1 — immutable evidence snapshots for an
   *  `evidence_captured` commitment (JSON array of
   *  `CommitmentEvidenceEntry`, `commitment-evidence.ts`).
   *  Deliberately NOT `source_extension_blob` — that is the
   *  Source-mirror extension lane (sync-owned); evidence is
   *  capture-owned and never rewritten by any sync (invariant 2:
   *  capture, never mirror). Same 8 KiB serialized cap as the
   *  extension lane (`COMMITMENT_EVIDENCE_BLOB_MAX_BYTES`). */
  evidence_blob?: readonly CommitmentEvidenceEntry[];
}

// ────────────────────────────────────────────────────────────────
// project (§ A.1.4)
// ────────────────────────────────────────────────────────────────

export const PROJECT_STATES = ['active', 'paused', 'completed', 'archived'] as const;
export type ProjectState = (typeof PROJECT_STATES)[number];
export const PROJECT_STATE_SET: ReadonlySet<ProjectState> = new Set(PROJECT_STATES);

export const PROJECT_TITLE_MAX = 200;

/** § A.1.4 — depth cap for `parent_project` chain. Validator gate +
 *  storage gate; can lift if real users need deeper. */
export const PROJECT_HIERARCHY_MAX_DEPTH = 3;

export interface Project extends SourceRowIdentity {
  id: string;
  title: string;
  description?: string;
  state: ProjectState;
  created_at: number;
  updated_at: number;
  target_completion_at?: number;
  /** Auto-updated when child task / note / commitment changes. PA4
   *  reactive triggers populate this. */
  last_activity_at: number;
  related_contact_ids: readonly string[];
  parent_project_id?: string;
  source_extension_blob?: Record<string, unknown>;
}

// ────────────────────────────────────────────────────────────────
// booking (D-210) — the canonical mutable reservation record
// ────────────────────────────────────────────────────────────────
//
// An approved reservation has two records, each answering a different question:
//
//   `reception_form_submission` — what the VISITOR asked for. Sealed,
//       write-once evidence, surfaced redacted at `#reception/records`.
//   `data.booking` (this)       — what the owner AGREED: its own start/end,
//       customer, value, lifecycle, and bounded owner-side history.
//
// A booking is never mirrored into `data.calendar`; calendar availability is an
// input to slot selection, not the destination of the business reservation.
//
// `lifecycle_state` is therefore the sole reservation lifecycle. It includes
// business outcomes such as `completed` and `no_show`, which do not belong to
// an iCalendar protocol row.
//
// Spec: D-210 Appendix A.

/** Business lifecycle — how the reservation progresses and ends. Follows
 *  `commitment`'s lifecycle-axis model (§ A.1.3) rather than borrowing a
 *  calendar protocol status.
 *
 *  `no_show` / `completed` are the two states that earn this entity:
 *  both are what an owner actually wants to count at the end of a month.
 *
 *  ⚠⚠ `pending` IS NOT THE DEFAULT, despite being first (owner-ruled
 *  2026-07-18). A Recued-minted booking is born `'confirmed'`: the
 *  reception path mints only at APPROVE, so the approval IS the
 *  confirmation and there is no moment at which Recued would write
 *  `pending`. It is carried for an owner- or pack-authored booking
 *  whose flow genuinely has a pre-confirmation step — the CRUD create
 *  / update ops are its writer, not any Recued producer. Order here is
 *  narrative (a human reads the lifecycle in this order); the default
 *  is stated explicitly at every default site — DDL, canonical schema,
 *  and create dispatcher — and pinned by test. Never write
 *  `BOOKING_LIFECYCLE_STATES[0]` as a default. */
export const BOOKING_LIFECYCLE_STATES = [
  'pending',
  'confirmed',
  'completed',
  'cancelled',
  'no_show',
] as const;

/** The state a Recued-minted booking is BORN in. Named rather than
 *  positional precisely because `pending` sorts first above. */
export const BOOKING_DEFAULT_LIFECYCLE_STATE: BookingLifecycleState = 'confirmed';
export type BookingLifecycleState = (typeof BOOKING_LIFECYCLE_STATES)[number];
export const BOOKING_LIFECYCLE_STATE_SET: ReadonlySet<BookingLifecycleState> = new Set(
  BOOKING_LIFECYCLE_STATES,
);

export const BOOKING_TITLE_MAX = 200;

export interface Booking extends SourceRowIdentity {
  id: string;
  /** What was booked — the service / topic, NOT the visitor's name
   *  (identity lives on `counterparty_contact_id`; the raw visitor
   *  email stays sealed on the reception record by construction). */
  title: string;
  lifecycle_state: BookingLifecycleState;
  created_at: number;
  updated_at: number;
  /** Last `lifecycle_state` change — mirrors `commitment`. */
  state_changed_at: number;
  /** The customer. Nullable: a visitor who booked without ever
   *  resolving to a contact is a real, common state (D-138's
   *  reconciliation is best-effort, and the F1 nullable-counterparty
   *  posture already established that a null counterparty is honest,
   *  not broken). */
  counterparty_contact_id?: string;
  /** What the booking is worth. Flattened to `monetary_amount` +
   *  `monetary_currency` in storage with a CHECK pairing them, exactly
   *  as `commitment` does. */
  monetary_value?: MonetaryValue;
  /** WHEN — the booking's own slot (D-210 A.2). Booking and calendar are
   *  DISJOINT, so this is the booking's own fact rather than a pointer
   *  to an event that owns it.
   *
   *  Present as a PAIR or not at all, enforced by a table CHECK and by
   *  `writeBooking`: a start with no end is a corrupt time, not a partly
   *  known one. Absent is a real state — an owner-authored enquiry can
   *  exist before a time is agreed.
   *
   *  ⚠ Duration is DERIVED (`slot_end_at - slot_start_at`), never
   *  stored. Storing it would hold one fact twice and let it drift. */
  slot_start_at?: number;
  slot_end_at?: number;
  /** Provenance — the `reception_form_submission.submission_id` this was
   *  promoted from. Absent for an owner-authored booking (nothing
   *  stops the owner minting one by hand). */
  reception_record_id?: string;
  source_extension_blob?: Record<string, unknown>;
}

/** Owner-only projection of a prior terminal booking. Deliberately excludes
 *  visitor email and free-form reception values; identity remains the opaque
 *  D-138 contact id on the enclosing summary. */
export interface BookingHistoryEntry {
  readonly id: string;
  readonly title: string;
  readonly lifecycle_state: Extract<BookingLifecycleState, 'completed' | 'no_show'>;
  readonly created_at: number;
  readonly state_changed_at: number;
  readonly slot_start_at?: number;
  readonly slot_end_at?: number;
}

export interface BookingHistorySummary {
  readonly counterparty_contact_id: string;
  readonly entries: readonly BookingHistoryEntry[];
  /** All matching completed/no-show rows, independent of the response cap. */
  readonly total: number;
}

// ────────────────────────────────────────────────────────────────
// Tagged work-entity record — used by the polymorphic resolver in PA2.
// ────────────────────────────────────────────────────────────────

export type WorkEntity =
  | ({ _kind: 'task' } & Task)
  | ({ _kind: 'note' } & Note)
  | ({ _kind: 'commitment' } & Commitment)
  | ({ _kind: 'project' } & Project)
  | ({ _kind: 'booking' } & Booking);

// ────────────────────────────────────────────────────────────────
// PA3 — Kernel CRUD ingredient input / output contracts (§ Phase PA3)
// ────────────────────────────────────────────────────────────────
//
// 14 ingredients across 4 kinds: task (4), note (3), commitment (4),
// project (3). Every input optionally accepts `source_id` — the
// substrate resolves to the per-kind default Source memory and falls
// back to the Recued built-in when absent. Every output returns the
// canonical record stamped with `_id` + `_collection` per the kernel
// adapter's stamping discipline.
//
// `commitment-fulfill` / `commitment-cancel` carry the lifecycle ×
// due_status state-machine validation that PA1 (§ A.1.3) deferred:
// pending → fulfilled / cancelled is the standard path, expired →
// fulfilled / cancelled is allowed only when `expiry_policy ===
// 'escalate_overdue'` (the spec's load-bearing requirement that
// monetary commitments must NOT silently disappear when the deadline
// passes), terminal lifecycle states (fulfilled / cancelled) reject
// further moves.

/** Allowed source moves on `commitment-fulfill`. */
export const COMMITMENT_FULFILL_FROM_STATES: ReadonlySet<CommitmentLifecycleState> =
  new Set(['pending', 'expired'] as const);

/** Allowed source moves on `commitment-cancel`. */
export const COMMITMENT_CANCEL_FROM_STATES: ReadonlySet<CommitmentLifecycleState> =
  new Set(['pending', 'expired'] as const);

/** § A.1.3 — when current lifecycle is `'expired'`, the move to
 *  `'fulfilled'` / `'cancelled'` is only allowed under
 *  `escalate_overdue` (the policy that names the load-bearing
 *  monetary-commitment invariant). Tighter than the general
 *  *_FROM_STATES set so the substrate refuses to "fulfill" a
 *  `strict_expire` commitment that already terminated. */
export const COMMITMENT_FULFILL_ALLOWED_EXPIRY_POLICIES: ReadonlySet<CommitmentExpiryPolicy> =
  new Set(['escalate_overdue', 'indefinite'] as const);

/** Common Source-selection input. Every PA3 write ingredient accepts
 *  this — `source_id` is optional (resolver falls back to the per-
 *  kind default Source memory, then to the Recued built-in for that
 *  kind). The substrate validates registration + kind match at
 *  dispatch time. */
export interface SourceSelectInput {
  source_id?: string;
}

// ── task-* ──────────────────────────────────────────────────────

export interface TaskCreateInput extends SourceSelectInput {
  title: string;
  /** Create-or-reuse one Recued-local task under this stable business key.
   * Idempotent creates never route to a sticky/vendor Source. */
  idempotency_key?: string;
  body?: string;
  due_at?: number;
  priority?: TaskPriority;
  /** D-179 fork (a) — free-form domain state + 0–100 progress. */
  state?: string;
  progress?: number;
  done?: boolean;
  completed_at?: number;
  assigned_contact_id?: string;
  parent_calendar_event_id?: string;
  linked_mail_thread_id?: string;
  parent_project_id?: string;
  blocks_task_ids?: readonly string[];
  source_extension_blob?: Record<string, unknown>;
}

export interface TaskUpdateInput {
  id: string;
  title?: string;
  body?: string;
  due_at?: number;
  priority?: TaskPriority;
  /** D-179 fork (a) — a changed `state` ALSO emits `state_changed`. */
  state?: string;
  progress?: number;
  assigned_contact_id?: string;
  parent_calendar_event_id?: string;
  linked_mail_thread_id?: string;
  parent_project_id?: string;
  blocks_task_ids?: readonly string[];
  source_extension_blob?: Record<string, unknown>;
}

export interface TaskDeleteInput {
  id: string;
  /** Tombstone (default true) preserves the row with `sync_state:
   *  'tombstoned'` so cascade history + audit references resolve.
   *  Hard-delete is escape-hatch only — the substrate's default is
   *  always tombstone per § A.1.6. */
  tombstone?: boolean;
}

export interface TaskMarkDoneInput {
  id: string;
  /** Defaults to true. Pass false to "un-complete" a task (rare —
   *  user-error correction). */
  done?: boolean;
  /** Defaults to now when `done: true`. Cleared when `done: false`. */
  completed_at?: number;
}

// ── note-* ──────────────────────────────────────────────────────

export interface NoteCreateInput extends SourceSelectInput {
  body: string;
  title?: string;
  related_contact_ids?: readonly string[];
  related_calendar_event_ids?: readonly string[];
  related_mail_thread_ids?: readonly string[];
  related_project_ids?: readonly string[];
  source_extension_blob?: Record<string, unknown>;
}

export interface NoteUpdateInput {
  id: string;
  body?: string;
  title?: string;
  related_contact_ids?: readonly string[];
  related_calendar_event_ids?: readonly string[];
  related_mail_thread_ids?: readonly string[];
  related_project_ids?: readonly string[];
  source_extension_blob?: Record<string, unknown>;
}

export interface NoteDeleteInput {
  id: string;
  tombstone?: boolean;
}

// ── commitment-* ────────────────────────────────────────────────

export interface CommitmentCreateInput extends SourceSelectInput {
  direction: CommitmentDirection;
  statement: string;
  derivation: CommitmentDerivation;
  promised_at?: number;
  promised_for_at?: number;
  expiry_policy?: CommitmentExpiryPolicy;
  derivation_confidence?: number;
  monetary_value?: MonetaryValue;
  counterparty_contact_id?: string;
  derived_from_mail_thread_id?: string;
  derived_from_meeting_id?: string;
  blocks_task_ids?: readonly string[];
  blocks_project_ids?: readonly string[];
  source_extension_blob?: Record<string, unknown>;
  /** D-192 F1 — immutable evidence snapshots. Create-only: an
   *  `evidence_captured` commitment binds ≥ 1 at mint (the capture
   *  producer composes them); deliberately ABSENT from
   *  `CommitmentUpdateInput` — evidence is never edited or cleared
   *  (invariant 2: capture, never mirror). */
  evidence_blob?: readonly CommitmentEvidenceEntry[];
}

/** `lifecycle_state` + `due_status` are NOT mutable through `commitment-update`
 *  — the dedicated `commitment-fulfill` / `commitment-cancel` ingredients are
 *  the only path. Updates here are metadata only. */
export interface CommitmentUpdateInput {
  id: string;
  statement?: string;
  promised_for_at?: number;
  expiry_policy?: CommitmentExpiryPolicy;
  monetary_value?: MonetaryValue;
  counterparty_contact_id?: string;
  derivation_confidence?: number;
  blocks_task_ids?: readonly string[];
  blocks_project_ids?: readonly string[];
  source_extension_blob?: Record<string, unknown>;
}

export interface CommitmentFulfillInput {
  id: string;
  /** Defaults to now. Stamped on both `state_changed_at` +
   *  `lifecycle_changed_at`. */
  fulfilled_at?: number;
}

export interface CommitmentCancelInput {
  id: string;
  /** Defaults to now. */
  cancelled_at?: number;
}

// ── project-* ───────────────────────────────────────────────────

export interface ProjectCreateInput extends SourceSelectInput {
  title: string;
  description?: string;
  state?: ProjectState;
  target_completion_at?: number;
  related_contact_ids?: readonly string[];
  parent_project_id?: string;
  source_extension_blob?: Record<string, unknown>;
}

export interface ProjectUpdateInput {
  id: string;
  title?: string;
  description?: string;
  state?: ProjectState;
  target_completion_at?: number;
  related_contact_ids?: readonly string[];
  parent_project_id?: string;
  source_extension_blob?: Record<string, unknown>;
}

export interface ProjectArchiveInput {
  id: string;
}

// ── booking-* ───────────────────────────────────────────────────

export interface BookingCreateInput extends SourceSelectInput {
  title: string;
  lifecycle_state?: BookingLifecycleState;
  /** Reschedule tuple: both or neither. */
  slot_start_at?: number;
  slot_end_at?: number;
  monetary_value?: MonetaryValue;
  counterparty_contact_id?: string;
  source_extension_blob?: Record<string, unknown>;
}

export interface BookingUpdateInput {
  id: string;
  title?: string;
  lifecycle_state?: BookingLifecycleState;
  /** Reschedule tuple: both or neither. */
  slot_start_at?: number;
  slot_end_at?: number;
  monetary_value?: MonetaryValue;
  counterparty_contact_id?: string;
  source_extension_blob?: Record<string, unknown>;
}

// ── Output shapes — every write returns the canonical record. ────

export interface TaskWriteOutput { task: Task; }
export interface NoteWriteOutput { note: Note; }
export interface CommitmentWriteOutput { commitment: Commitment; }
export interface ProjectWriteOutput { project: Project; }
export interface BookingWriteOutput { booking: Booking; }

export interface WorkEntityDeleteOutput {
  ok: true;
  id: string;
  /** True when the deleted row was tombstoned (default), false when
   *  hard-deleted. */
  tombstoned: boolean;
}

// ────────────────────────────────────────────────────────────────
// PA4 — Reactive trigger constants
// ────────────────────────────────────────────────────────────────

/** D-145 PA4 — Warehouse-bus path constants for work-entity events.
 *
 *  Path convention is the standard
 *  `data.{platform}.{slug}.{entity_type}.{event_kind}` — chosen so the
 *  matcher + binder stay collection-agnostic. For the work-entity
 *  family the substrate uses:
 *
 *    - `platform` = `'work'`
 *    - `slug`     = the `WorkEntityKind` (`'task' | 'note' |
 *                   'commitment' | 'project'`) — keeps the path
 *                   single-segment per entity_type so pattern matching
 *                   stays clean (Source ids contain `.` so they cannot
 *                   slot into `slug` directly).
 *    - `entity_type` = `'item'` — generic; per-Source filtering happens
 *                   via the bound recipe's `event_triggers[].filter`
 *                   matching `payload.source_id`.
 *    - `event_kind` = standard (`created` / `updated` / `deleted`) plus
 *                   the four PA4 derived kinds (`completed` /
 *                   `due_soon` / `overdue` / `state_changed`).
 *
 *  Recipes subscribe with patterns like `data.work.task.item.created`
 *  (any task created on any Source) or `data.work.commitment.item.due_soon`. */
export const WORK_ENTITY_BUS_PLATFORM = 'work';
export const WORK_ENTITY_BUS_ENTITY_TYPE = 'item';

/** Compose the warehouse-bus path for a work-entity event. */
export const composeWorkEntityBusPath = (
  kind: WorkEntityKind,
  event_kind: string,
): string =>
  `data.${WORK_ENTITY_BUS_PLATFORM}.${kind}.${WORK_ENTITY_BUS_ENTITY_TYPE}.${event_kind}`;

/** D-145 PA4 — closed list of derived event kinds emitted by the
 *  work-entity dispatchers + due-status sweep. The standard `created` /
 *  `updated` / `deleted` kinds are NOT in this list — they're emitted
 *  uniformly across collections. These derived kinds are work-entity-
 *  specific lifecycle / deadline transitions that recipes subscribe to
 *  individually. */
export const WORK_ENTITY_DERIVED_EVENT_KINDS = [
  'completed',
  'due_soon',
  'overdue',
  'state_changed',
] as const;
export type WorkEntityDerivedEventKind =
  (typeof WORK_ENTITY_DERIVED_EVENT_KINDS)[number];

/** D-145 PA4 — Due-soon window in milliseconds. § A.1.3 specifies the
 *  `due_status: not_due → due_soon` transition fires when the clock
 *  advances past `promised_for_at - 24h`. Same window applies to tasks
 *  with `due_at` (no spec-level distinction; the 24h horizon is a
 *  human-attention default). */
export const WORK_ENTITY_DUE_SOON_WINDOW_MS = 24 * 60 * 60 * 1000;
