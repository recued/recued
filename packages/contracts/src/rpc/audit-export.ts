/** D-120 Phase 7 — unified memory export contracts.
 *
 *  Three surfaces share one wire format:
 *
 *    - Per-recipe export        (Recipe card → ⋯ menu → Export memory)
 *    - Local-scope full export  (Local scope → Dashboard → Memory tab → Export)
 *    - Server-scope full export (Server scope → Dashboard → Memory tab → Export)
 *
 *  The first two run on top of the extension's IDB-backed audit store; the
 *  third runs on the paired server's SQLite store. All three serialize
 *  through `packages/storage/src/audit-export.ts` so the envelope shape +
 *  field order + header dedup behave identically across surfaces — a JSON
 *  diff between a local export and a server export of the same window
 *  yields zero structural noise.
 *
 *  The `audit.export.estimate` + `audit.export.page` pair covers the
 *  unified dialog: the dialog calls `estimate` to populate the live
 *  count/size preview before the user commits, then streams `page`
 *  calls until `next_cursor` goes undefined. (D-157 P0 deleted the
 *  pre-D-120 single-blob `audit.export` rpc — this pair is the whole
 *  `audit.*` rpc surface.)
 *
 *  Spec: docs/d-120-spec.md (Phase 7 — Memory rename + unified export).
 */

import type { RunAnchorStatus } from '../commits.js';

/** Output formats. JSON is the default (self-contained envelope, ideal
 *  archival). JSONL streams one entry per line with the envelope on a
 *  `_meta` row — best for grep/CLI piping. CSV flattens to a tabular
 *  shape with links collapsed to `;`-joined strings; lossy on shape but
 *  consumable by spreadsheets/BI without parsing. */
export type AuditExportFormat = 'json' | 'jsonl' | 'csv';

/** Closed enumeration of date-range presets surfaced in the dialog.
 *  `all` translates to `since: undefined / until: undefined` (no filter);
 *  `custom` defers to the dialog's free-form picker (translates to
 *  whatever bounds the user drags). Default preset is `'30d'`. */
export type AuditExportPreset = '7d' | '30d' | '90d' | '1y' | 'all' | 'custom';

/** Hard cap on returned entries per page. Server clamps `page_size`
 *  down to this when callers exceed it. Tuned to keep a single-page
 *  payload under ~5 MB JSON for power-user warehouses. */
export const AUDIT_EXPORT_MAX_PAGE_SIZE = 1000;

/** Default page size when callers omit `page_size`. Tuned to fit a
 *  comfortable browser-side download chunk without forcing too many
 *  round-trips on small exports. */
export const AUDIT_EXPORT_DEFAULT_PAGE_SIZE = 500;

/** Inbound shape for `audit.export.estimate`. Same filter knobs as
 *  `audit.export.page` so the dialog can preview the cost of a
 *  forthcoming export with one cheap call. The estimate skips the
 *  expensive serialize+envelope steps; it returns just the counts. */
export interface AuditExportRequest {
  /** Inclusive lower bound on `started_at`. Omitted = no lower bound. */
  since?: number;
  /** Inclusive upper bound on `started_at`. Omitted = no upper bound. */
  until?: number;
  /** Filter to a single recipe. Omitted = all recipes (full export). */
  recipe_id?: string;
  /** Wire format. Default `'json'`. */
  format?: AuditExportFormat;
  /** Page size for `audit.export.page` calls. Server clamps to
   *  `AUDIT_EXPORT_MAX_PAGE_SIZE`. Ignored by `estimate`. */
  page_size?: number;
  /** Opaque pagination token. First-page callers omit it; subsequent
   *  calls pass back the previous response's `next_cursor`. */
  cursor?: string;
}

/** Outbound shape for `audit.export.estimate`. Cheap to compute — the
 *  server runs `COUNT(*)` over the date range and applies a constant-
 *  per-entry byte estimate (±10% accuracy is fine; the goal is
 *  preventing a multi-GB surprise, not auditing). */
export interface AuditExportEstimate {
  /** Number of memory entries the export will include. */
  entry_count: number;
  /** Approximate serialized size of the export in bytes. Format-aware:
   *  CSV is typically ~0.6× of JSON for the same row set. */
  estimated_bytes: number;
}

/** Provenance/header block embedded in the first page of a multi-page
 *  export (and the only block present on a single-page export). Identical
 *  shape across local + server scopes — only `instance_id` and `scope`
 *  differ at runtime. */
export interface AuditExportEnvelope {
  /** ISO8601 — when the export started. */
  exported_at: string;
  /** Originating instance id (extension UUID for local; server pair-id
   *  for server scope). */
  instance_id: string;
  /** Where the export ran. */
  scope: 'local' | 'server';
  /** Lower bound used (ISO8601 or `null` when unbounded). */
  since: string | null;
  /** Upper bound used (ISO8601 or `null` when unbounded). */
  until: string | null;
  /** Recipe filter applied (or `null` for full export). */
  recipe_filter: string | null;
  /** Format the body was serialized as. */
  format: AuditExportFormat;
  /** Recipe-shape snapshots referenced by entries in this export.
   *  Deduped at the envelope level so the body never repeats a
   *  flattened recipe payload. Keyed by FNV-1a hash; entries reference
   *  back via `recipe_hash`. Empty when the export contains no entries
   *  with `recipe_insight_id`. */
  recipe_insights: Record<
    string,
    {
      slug: string;
      version: number;
      flattened: unknown;
    }
  >;
}

/** Outbound shape for `audit.export.page`. The first page carries the
 *  `envelope`; subsequent pages omit it (the envelope is fixed once the
 *  export starts so re-shipping it would only add noise — stitching
 *  pages together is the consumer's job).
 *
 *  `body` is the format-specific serialization of THIS page's memory
 *  entries:
 *    - `'json'`  — JSON array (no surrounding object), one entry per
 *                   array element. Concatenate with `,` between pages
 *                   and wrap with `{...envelope..., "memory":[...]}`
 *                   to reconstruct the full archive.
 *    - `'jsonl'` — one entry per line, no array brackets. The first
 *                   page additionally prepends a `_meta` line carrying
 *                   the envelope.
 *    - `'csv'`   — one row per line. The first page prepends the
 *                   header row.
 *
 *  `next_cursor` is present iff at least one more page exists. */
export interface AuditExportPage {
  envelope?: AuditExportEnvelope;
  body: string;
  /** Number of entries in `body` (not bytes). Lets consumers track
   *  progress against `entry_count` from the estimate. */
  entries_in_page: number;
  next_cursor?: string;
}

/** Per-entry shape inside the exported envelope's `memory` array (JSON
 *  format) — what the body serializes one of per row. Mirrors the
 *  storage `AuditEntry` shape but elides redacted fields and adds the
 *  `links` block populated by joining the D-120 `links` table. Pre-D-120
 *  audit entries (no `recipe_insight_id`) export with `links: []` and
 *  no entry in the envelope's `recipe_insights` block — round-trip safe
 *  even on very old logs. */
export interface AuditExportEntry {
  id: string;
  recipe_id: string;
  recipe_hash: string;
  started_at: number;
  finished_at: number;
  duration_ms: number;
  /** Run-anchor lifecycle state — a `RunAnchorStatus` (D-157 P1 widened
   *  it from `CommitStatus`). Replaces pre-D-153 `success: boolean`;
   *  legacy callers' `true` / `false` write `'succeeded'` / `'failed'`
   *  here. Other values come from the Gateway dispatch outbox + the
   *  D-157 preflight gate (`'awaiting_approval'`). */
  commit_status: RunAnchorStatus;
  trigger_source: string | null;
  trigger_url: string | null;
  instance_id: string | null;
  process_id?: string;
  config_snapshot: Record<string, unknown>;
  errors: Array<{ code: string; message?: string; step_id?: string }>;
  output_string?: string;
  recipe_insight_id?: number;
  /** Engine-emitted causal links for this run, joined from the
   *  `links` table where `memory_id === id`. Empty array when no
   *  link rows exist (pre-D-120 entries, opt-out runs, runs that
   *  touched no entities). Inlined here rather than in a separate
   *  envelope block because consumers almost always want links
   *  alongside the entry that produced them. */
  links: Array<{
    entity_id: string;
    kind: string;
    ts: number;
  }>;
  // D-153 P1.B — three-tier session ID pass-through for exports.
  // Surfaced so an exported audit archive stays groupable by channel
  // session / cognition arc / correlation burst offline.
  channel_session_id?: string;
  cognition_session_id?: string;
  correlation_id?: string;
}

/** Translate a preset to `(since, until)` bounds against the supplied
 *  `now`. `'all'` → `(undefined, undefined)`; `'custom'` is an error
 *  (the dialog must supply explicit bounds for that case — the helper
 *  isn't responsible for free-form picking). Pure helper exposed so
 *  the dialog + tests + the server-side filter share one source of
 *  truth. */
export const presetToBounds = (
  preset: AuditExportPreset,
  now: number,
): { since?: number; until?: number } => {
  if (preset === 'all') return {};
  if (preset === 'custom') {
    throw new Error("presetToBounds: 'custom' requires explicit bounds");
  }
  const day = 86_400_000;
  const days = preset === '7d' ? 7 : preset === '30d' ? 30 : preset === '90d' ? 90 : 365;
  return { since: now - days * day, until: now };
};

/** Average serialized bytes per memory entry, derived from a sample of
 *  production-shape audit rows. Used by `audit.export.estimate` to
 *  approximate `estimated_bytes` without serializing the full export.
 *  Format-specific: CSV is denser (no field names), JSONL parallels
 *  JSON closely (slight header savings). */
export const AUDIT_EXPORT_BYTES_PER_ENTRY: Record<AuditExportFormat, number> = {
  json: 1_500,
  jsonl: 1_400,
  csv: 900,
};

/** Clamp + default `page_size` against the contract's bounds. Negative
 *  / zero / NaN / undefined → default; values above the ceiling clamp
 *  down. Mirrors `clampTimelineLimit` in `mcp.ts` so the two MCP-style
 *  paginated surfaces share clamp semantics. */
export const clampAuditExportPageSize = (
  page_size: number | undefined,
): number => {
  if (page_size === undefined) return AUDIT_EXPORT_DEFAULT_PAGE_SIZE;
  if (!Number.isFinite(page_size) || page_size <= 0) {
    return AUDIT_EXPORT_DEFAULT_PAGE_SIZE;
  }
  return Math.min(Math.floor(page_size), AUDIT_EXPORT_MAX_PAGE_SIZE);
};
