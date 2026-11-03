/** D-198 — owner-trusted memory-management rpc contracts.
 *
 *  The paired-client surface for the D-120 `data.memory.*` provenance
 *  timeline: list / create / update / delete / import. Bearer-`user_self`,
 *  NO contract gate (the owner acting on their own paired server — mirrors
 *  `data.timeline` / `data.file.read`), still audited. Export reuses the
 *  existing `audit.export.*` pair (`./audit-export.js`).
 *
 *  Authorization is origin-scoped (D-198 §3): the owner has full CRUD on
 *  their own `user_self` entries; engine / AI / contracted rows are view +
 *  redact/retain only, and a row's `origin_actor` is immutable. Handlers
 *  enforce this in Slice 1+; these contracts describe the wire shapes.
 *
 *  Body storage (D-198 §5): a memory row lives in the one pool (origin-
 *  tagged); its body follows the canonical 64 KB split — inline UTF-8 text
 *  when ≤ 64 KB, else a CAS blob (the `collections.ts` `body_inline` /
 *  `blob_hash` convention). The feed (`memory.list`) ships only
 *  `body_preview` + `size_bytes` — never the full body, which large text
 *  would bloat; the full body loads on demand via `memory.get` (Slice 2).
 *
 *  Spec: D-198 (§5 operations) + D-198 (§A.1).
 */

import type { Actor } from '../commits.js';
import type { ProvenanceAttribution } from '../provenance-attribution.js';
import type { MemoryClaim } from '../memory-relations.js';

/** Hard cap on entries returned by a single `memory.list` page. Mirrors
 *  `AUDIT_EXPORT_MAX_PAGE_SIZE`; the server clamps `limit` down to this. */
export const MEMORY_LIST_MAX_PAGE_SIZE = 500;

/** Default `memory.list` page size when the caller omits `limit`. */
export const MEMORY_LIST_DEFAULT_PAGE_SIZE = 100;

/** Inbound shape for `memory.list` — the transparent, origin-filterable
 *  feed backing the `#data` Memory lens. All filters are optional; an empty
 *  request lists the most recent entries across EVERY origin (full
 *  transparency, D-198 §3). Newest-first, opaque-cursor pagination. */
export interface MemoryListRequest {
  /** Restrict to these write-actors (D-161 `origin_actor`). Omitted = every
   *  origin (You / AI / each contract). Built on the storage
   *  `listByAudit(origin_actors)` filter. */
  origin_actors?: Actor[];
  /** Restrict to one entry `kind`. Omitted = all kinds. */
  kind?: string;
  /** Inclusive lower bound on the entry's effective time
   *  (`COALESCE(event_at, ts)`, D-120 P7.5). Omitted = unbounded. */
  since?: number;
  /** Inclusive upper bound on the entry's effective time. Omitted =
   *  unbounded. */
  until?: number;
  /** Page size; the server clamps to `MEMORY_LIST_MAX_PAGE_SIZE`. */
  limit?: number;
  /** Opaque pagination token; first-page callers omit it. */
  cursor?: string;
}

/** A single memory row as surfaced by `memory.list`. Covers BOTH audit rows
 *  and authored `user_memory` rows (`user_self` or `contracted_user`) — the
 *  `origin_actor` discriminates, and every origin is displayed (D-198 §3).
 *  `body` carries user-authored payload; it is absent (or `redacted`) for
 *  rows the owner may view but not read into. */
export interface MemoryListEntry {
  memory_id: string;
  origin_actor: Actor;
  /** Derived at read time for outside-authored rows. Never stored: audit rows
   * derive it from execution_source + contract_snapshot; authored-memory rows
   * derive it from their existing origin_actor + contract_id facets. Absent for
   * first-person user_self/system rows. */
  attribution?: ProvenanceAttribution;
  /** Entry kind — the audit row's kind, or the user-memory kind. */
  kind: string;
  /** Short audit-clean summary (≤ `AUDIT_OUTPUT_STRING_MAX`). */
  summary?: string;
  /** Clamped preview of the entry body for the feed row. The full body
   *  (inline ≤ 64 KB or a large CAS blob, D-198 §5) loads on demand via
   *  `memory.get` (Slice 2) — never shipped in the list, which large text
   *  would bloat. Absent for audit rows (which carry only `summary`). */
  body_preview?: string;
  /** Total body size in bytes (inline + blob). Drives the size chip + the
   *  "expand" affordance. Absent when the entry has no body. */
  size_bytes?: number;
  /** True when a full body exists to fetch via `memory.get` (user/AI-authored
   *  entries); false/absent for engine audit rows. */
  has_body?: boolean;
  /** Closed-list reason the entry was written (D-145 `memory.write` parity). */
  reason_code?: string;
  /** Ingestion time — when Recued recorded the entry. */
  ts: number;
  /** Real-world event time when distinct from ingestion (bistemporal,
   *  D-120 P7.5). */
  event_at?: number;
  /** True when the row has been redacted (content cleared; provenance
   *  skeleton + origin retained). */
  redacted?: boolean;
  /** Present when audit-authored — links out to `#logs/<run_id>`. */
  run_id?: string;
  /** Provenance edges (D-120 `links`), joined where `memory_id` matches. */
  links?: Array<{ entity_id: string; kind: string; ts: number }>;
  /** D-336 — the note's fact as subject, relation and object, when it was saved with one.
   *  Absent once the note is deleted or hidden. */
  claim?: MemoryClaim;
  /** D-198 §10 — the earlier entry this one replaced (an agent's correction). */
  replaces?: string;
  /** D-198 §10 — the newer entry that replaced this one. Recall skips this entry;
   *  the owner forgetting the newer one makes this one current again. */
  replaced_by?: string;
  /** D-198 §10 — set when an AGENT forgot the entry: who, in the owner's terms
   *  ("your chat", or the agent's contract). The owner can restore it with
   *  `memory.restore`. Absent on the owner's own redactions. */
  forgotten_by?: string;
  /** D-198 §10 — the reason the agent gave when it forgot the entry. */
  forgotten_reason?: string;
  /** D-198 §13 — when the owner DELETED this agent's note. Its text is gone from
   *  the server; the entry stays as who saved what kind of note when. Nothing
   *  restores it. Absent on a forget, which redacts without deleting. */
  deleted_at?: number;
  /** D-198 §13 — when the owner REVOKED this agent's note (marked it wrong). Its text
   *  stays, shown to the owner; out of recall as a fact. `memory.unrevoke` lifts it. */
  revoked_at?: number;
  /** D-336 slice G (§3.9) — the notes in memory this one contradicts: the same two ends,
   *  with a relation the list says excludes its own. On a current note only, against
   *  current notes, so the mark goes once one of them is replaced or removed. */
  contradicts?: MemoryContradiction[];
}

/** D-336 slice G — a note another contradicts, by its id and its summary. */
export interface MemoryContradiction {
  memory_id: string;
  summary: string;
}

/** Outbound shape for `memory.list`. `next_cursor` present iff another
 *  page exists. */
export interface MemoryListResponse {
  entries: MemoryListEntry[];
  next_cursor?: string;
}

/** Inbound shape for `memory.get` — resolves the FULL body of one entry for
 *  the detail view (the feed ships only `body_preview`, D-198 §5). */
export interface MemoryGetRequest {
  memory_id: string;
}

/** Outbound shape for `memory.get`. `body` is the full content — small
 *  `body_inline` or the large CAS blob, resolved by the handler — and is
 *  absent for engine audit rows (which carry no body, only `summary`).
 *  Origin visibility rules apply upstream (§3). */
export interface MemoryGetResponse {
  memory_id: string;
  origin_actor: Actor;
  /** Same zero-new-storage outside-actor attribution as memory.list. */
  attribution?: ProvenanceAttribution;
  kind: string;
  summary?: string;
  /** The full resolved body (inline or from CAS). */
  body?: string;
  /** D-336 — the note's claim, as on `memory.list`. */
  claim?: MemoryClaim;
  reason_code?: string;
  ts: number;
  event_at?: number;
  size_bytes?: number;
  redacted?: boolean;
  run_id?: string;
  /** D-198 §10 — the earlier entry this one replaced (an agent's correction). */
  replaces?: string;
  /** D-198 §10 — the newer entry that replaced this one. Recall skips this entry;
   *  the owner forgetting the newer one makes this one current again. */
  replaced_by?: string;
  /** D-198 §10 — set when an AGENT forgot the entry: who, in the owner's terms
   *  ("your chat", or the agent's contract). The owner can restore it with
   *  `memory.restore`. Absent on the owner's own redactions. */
  forgotten_by?: string;
  /** D-198 §10 — the reason the agent gave when it forgot the entry. */
  forgotten_reason?: string;
  /** D-198 §13 — when the owner DELETED this agent's note. Its text is gone from
   *  the server; the entry stays as who saved what kind of note when. Nothing
   *  restores it. Absent on a forget, which redacts without deleting. */
  deleted_at?: number;
  /** D-198 §13 — when the owner REVOKED this agent's note (marked it wrong). Its text
   *  stays, shown to the owner; out of recall as a fact. `memory.unrevoke` lifts it. */
  revoked_at?: number;
  /** D-336 slice G — the notes this one contradicts, as on `memory.list`. */
  contradicts?: MemoryContradiction[];
}

/** Inbound shape for `memory.restore` (D-198 §10) — the owner undoes an AGENT's
 *  forget. `memory_id` may be the forgotten entry or any earlier version forgotten
 *  with it; every mark of that one forget is lifted. The owner's own redactions are
 *  not restorable here. */
export interface MemoryRestoreRequest {
  memory_id: string;
}

/** Result of a `memory.restore` — how many versions came back. */
export interface MemoryRestoreResult {
  memory_id: string;
  restored: number;
}

/** Inbound shape for `memory.create` — authors a NEW `user_self` memory
 *  entry (the owner's own). The handler stamps `origin_actor: user_self`
 *  server-side; a caller can never author a row of another origin (the
 *  origin-honesty invariant, D-198 §3). */
export interface MemoryCreateRequest {
  kind: string;
  summary?: string;
  /** The memory content — a small string or large text. Stored via the
   *  canonical 64 KB split (D-198 §5): ≤ 64 KB inline on the row, > 64 KB to
   *  a CAS blob. Content-addressing gives the import content-dedup for free. */
  body?: unknown;
  /** Closed-list reason code; the handler defaults one for owner writes. */
  reason_code?: string;
  /** Real-world event time, when the memory is about a past event. */
  event_at?: number;
  /** Entity ids to link the new memory to (D-120 provenance edges). */
  provenance_entity_ids?: string[];
  /** D-336 slice E — the note's fact as a relationship, beside its summary. The owner's
   *  own relation is allowed; a linked end must be in contacts or among their things. */
  claim?: MemoryClaim;
}

/** Inbound shape for `memory.update` — edits the caller's OWN `user_self`
 *  entry. Only `user_self`-origin rows are mutable; the handler rejects
 *  updates to engine/AI/contracted rows (view + redact only). `origin_actor`
 *  is never patchable. */
export interface MemoryUpdateRequest {
  memory_id: string;
  kind?: string;
  summary?: string;
  body?: unknown;
  event_at?: number;
  /** D-336 slice E — a claim replaces the note's, `null` drops it, absent leaves it. */
  claim?: MemoryClaim | null;
}

/** Inbound shape for `memory.replace` (D-198 §12) — the owner replaces an AGENT's
 *  entry with their own version. Writes a NEW `user_self` row carrying
 *  `replaces: memory_id`; the agent's row is never touched, and deleting the
 *  owner's version makes the agent's current again. Only a live, current agent
 *  (`contracted_user`) entry can be replaced. A method of its own rather than a
 *  field on `memory.create`: an older server refuses an unknown method
 *  (`unknown_method`) where it would silently ignore an unknown field and save
 *  an unlinked note. */
export interface MemoryReplaceRequest {
  /** The agent entry to replace — its current version. */
  memory_id: string;
  kind: string;
  summary?: string;
  /** Same shape and storage as `memory.create`'s body. */
  body?: unknown;
  event_at?: number;
  /** D-336 slice E — your version's claim, often the agent's with a name linked. */
  claim?: MemoryClaim;
}

/** Inbound shape for `memory.revoke` (D-198 §13) — the owner marks an AGENT's note
 *  WRONG. The note stays, shown to the owner, and leaves recall as a fact; it and every
 *  earlier version it replaced are marked under one revoke. A method of its own, so an
 *  older server refuses it (`unknown_method`). */
export interface MemoryRevokeRequest {
  memory_id: string;
}

/** Inbound shape for `memory.unrevoke` (D-198 §13) — lift the owner's revoke: the note
 *  and the versions marked with it are as they were. */
export interface MemoryUnrevokeRequest {
  memory_id: string;
}

/** Result of a `memory.revoke` / `memory.unrevoke` — how many versions it marked or
 *  lifted. */
export interface MemoryRevokeResult {
  memory_id: string;
  versions: number;
}

/** Inbound shape for `memory.saves` (D-198 §13) — how many times an agent saved an AGENT
 *  note's claim, asked by the Delete confirm before it offers Revoke ("An agent has saved
 *  this 3 times. Mark it wrong so it asks you first?"). A method of its own, so an older
 *  server refuses it (`unknown_method`) and the confirm asks as it always did. */
export interface MemorySavesRequest {
  memory_id: string;
}

/** Result of a `memory.saves`. `saves` counts the note and each earlier save of its claim
 *  that no longer stands (deleted, forgotten, hidden or revoked), as far as the server can
 *  still tell: a deleted note counts while the chat it was saved in still records the
 *  save, so it is a lower bound. `agents` — how many different agents made them (≥ 1). */
export interface MemorySavesResult {
  memory_id: string;
  saves: number;
  agents: number;
}

/** Inbound shape for `memory.claims` (D-336 slice D) — the notes whose claim names a
 *  contact or a thing the owner keeps, for the Relationships section of its page. One of
 *  the two: a contact by email or `contact_id`, a thing by any id the work tools use. A
 *  method of its own, so an older server refuses it (`unknown_method`) and the page shows
 *  no section. */
export interface MemoryClaimsRequest {
  contact?: string;
  asset?: string;
}

/** One note a `memory.claims` answer lists. `by` says how it names the record: its claim
 *  links the record (`record`), or names it in words that match the record's name
 *  (`name`), which may be someone else of that name. */
export interface MemoryClaimsEntry {
  memory_id: string;
  origin_actor: Actor;
  summary?: string;
  claim: MemoryClaim;
  by: 'record' | 'name';
  ts: number;
  event_at?: number;
}

/** Result of a `memory.claims`: the current notes, newest first. A removed, replaced or
 *  revoked note is never listed. */
export interface MemoryClaimsResult {
  claims: MemoryClaimsEntry[];
}

/** D-336 slice K (§5) — what the relation list misses, counted from this server's own notes,
 *  since nothing leaves it (D-097). Only notes that stand count: none forgotten, hidden,
 *  deleted or revoked, and none replaced by one that is not. */
export interface MemoryClaimCountsResult {
  /** The notes an AI saved. */
  agent_notes: number;
  /** Of those, the ones saved with no relationship: no listed relation fitted, or the AI gave
   *  none. */
  agent_notes_without_claim: number;
  /** The relations written in the owner's own words (an agent's must be on the list), each with
   *  how many notes use it, most used first. The words are the newest such note's. */
  own_relations: Array<{ relation: string; notes: number }>;
}

/** Result of a `memory.create` / `memory.update` / `memory.replace` (the NEW
 *  row's id for a replace). */
export interface MemoryMutationResult {
  memory_id: string;
  /** Provenance edges actually written (may be < requested when some
   *  target entities are missing). */
  provenance_edges_written: number;
}

/** Inbound shape for `memory.delete`. Origin-split at the handler:
 *  `user_self` rows hard-delete; an agent's note is deleted with its text erased
 *  and a content-free row kept (D-198 §13); a run redacts ("Hide from AI", §5). */
export interface MemoryDeleteRequest {
  memory_id: string;
}

/** Result of a `memory.delete` — reports which path ran. Exactly one of
 *  `deleted` / `redacted` is true on success. */
export interface MemoryDeleteResult {
  memory_id: string;
  /** True when the content is gone: the caller's own `user_self` entry was
   *  hard-deleted, or an agent's note was erased (D-198 §13 — its text removed,
   *  a content-free row kept). */
  deleted: boolean;
  /** True when the row was redacted in place (a run — content hidden from AI
   *  readers, the signed log untouched). An older server also redacts an agent's
   *  note this way, so its text is still on that server. */
  redacted: boolean;
}

/** A single entry accepted by `memory.import`. Shaped after the exported
 *  `AuditExportEntry` but tolerant of hand-authored `user_self` rows. The
 *  dedup key is origin-split (D-198 §5): `user_self` entries merge by
 *  `memory_id`; every other origin content-dedups (the substrate hashes the
 *  content — the D-136 `source_record_hash` precedent — so re-importing the
 *  same knowledge never duplicates). D-336: the content is the words and the
 *  claim, so two notes in the same words about two different people stay two;
 *  one with no claim matches a note in its words, whatever that note's claim. */
export interface MemoryImportEntry {
  /** Present for `user_self` entries (drives merge-by-id). Absent/ignored
   *  for "other" entries, which dedup by content. */
  memory_id?: string;
  origin_actor: Actor;
  kind: string;
  summary?: string;
  body?: unknown;
  reason_code?: string;
  ts?: number;
  event_at?: number;
  provenance_entity_ids?: string[];
  /** D-336 §3.8 — the note's claim as exported. A linked end keeps its record when that
   *  record exists here, else it becomes its name; a relation not in this server's
   *  list comes in as written. A claim that is not one is left out; the note is not. */
  claim?: MemoryClaim;
}

/** Inbound shape for `memory.import`. */
export interface MemoryImportRequest {
  entries: MemoryImportEntry[];
}

/** Result of a `memory.import` — a per-outcome tally. */
export interface MemoryImportResult {
  /** `user_self` entries upserted onto an existing `memory_id`. */
  merged: number;
  /** Entries inserted as new rows. */
  inserted: number;
  /** "Other" entries skipped because a note with their words already exists, and with their
   *  claim when they have one. */
  deduped: number;
  /** Entries rejected (malformed, or a disallowed origin transition). */
  skipped: number;
}
