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
  reason_code?: string;
  ts: number;
  event_at?: number;
  size_bytes?: number;
  redacted?: boolean;
  run_id?: string;
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
}

/** Result of a `memory.create` / `memory.update`. */
export interface MemoryMutationResult {
  memory_id: string;
  /** Provenance edges actually written (may be < requested when some
   *  target entities are missing). */
  provenance_edges_written: number;
}

/** Inbound shape for `memory.delete`. Origin-split at the handler:
 *  `user_self` rows hard-delete; every other origin redacts (D-198 §5). */
export interface MemoryDeleteRequest {
  memory_id: string;
}

/** Result of a `memory.delete` — reports which path ran. Exactly one of
 *  `deleted` / `redacted` is true on success. */
export interface MemoryDeleteResult {
  memory_id: string;
  /** True when the row was hard-deleted (the caller's own `user_self`
   *  entry). */
  deleted: boolean;
  /** True when the row was redacted in place (engine/AI/contracted row —
   *  content cleared, origin + provenance skeleton retained). */
  redacted: boolean;
}

/** A single entry accepted by `memory.import`. Shaped after the exported
 *  `AuditExportEntry` but tolerant of hand-authored `user_self` rows. The
 *  dedup key is origin-split (D-198 §5): `user_self` entries merge by
 *  `memory_id`; every other origin content-dedups (the substrate hashes the
 *  content — the D-136 `source_record_hash` precedent — so re-importing the
 *  same knowledge never duplicates). */
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
  /** "Other" entries skipped because their content already exists. */
  deduped: number;
  /** Entries rejected (malformed, or a disallowed origin transition). */
  skipped: number;
}
