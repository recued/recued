/** D-120 Phase 7 — shared memory-export serializer.
 *
 *  Both the extension (IDB-backed `AuditLogStore`) and the server
 *  (SQLite-backed audit + links) call into this module to produce the
 *  unified export envelope. By centralising the envelope shape + per-
 *  format body serializer here, a JSON diff between a local export and
 *  a server export of the same window has zero structural noise — the
 *  only differences are `instance_id`, `scope`, and the actual entry
 *  set.
 *
 *  Storage adapters supply the data via two cheap callbacks
 *  (`fetchEntries`, `fetchLinks`, `fetchInsight`); the serializer owns
 *  the cursor, dedup, and format logic. Callers stay backend-agnostic.
 *
 *  Spec: D-120 (Phase 7 — Memory rename + unified export).
 */

import {
  AUDIT_EXPORT_BYTES_PER_ENTRY,
  clampAuditExportPageSize,
  type AuditExportEntry,
  type AuditExportEnvelope,
  type AuditExportEstimate,
  type AuditExportFormat,
  type AuditExportPage,
  type AuditExportRequest,
} from '@recued/contracts';
import type { AuditEntry } from './audit.js';

/** Cursor format used by `audit.export.page`. Encoded as base64-url
 *  on the wire (URL-safe so the dialog can stash it in a query
 *  string when the user pages). The fields mirror the underlying
 *  storage's natural ORDER BY: descending `started_at` with `run_id`
 *  as the tiebreaker so concurrent runs at the same millisecond
 *  paginate deterministically. */
export interface AuditExportCursor {
  last_started_at: number;
  last_run_id: string;
}

/** Per-link row joined onto an entry by the storage adapter. Mirrors
 *  the wire `AuditExportEntry.links` element so callers can fan a
 *  bulk fetch into a per-entry map without re-shaping. */
export interface AuditExportLinkRow {
  memory_id: string;
  entity_id: string;
  kind: string;
  ts: number;
}

/** Insight payload joined onto the envelope by the storage adapter.
 *  Server reads from `recipe_insights`; extension reads from the
 *  IDB-backed `RecipeInsightsStore`. Same shape on both sides — the
 *  envelope blocks deduped by FNV-1a hash. */
export interface AuditExportInsightRow {
  hash: string;
  slug: string;
  version: number;
  flattened: unknown;
}

/** Storage-adapter callbacks supplied by the caller. The serializer
 *  knows nothing about IDB / SQLite — it just asks for slices of data
 *  bounded by the request's filter + cursor. */
export interface AuditExportSource {
  /** Fetch the next page of audit entries newest-first. The adapter
   *  applies `since` / `until` / `recipe_id` filters server-side and
   *  enforces the cursor (entries strictly older than
   *  `cursor.last_started_at`, or equal-ts but lex-smaller `run_id`).
   *  Returns at most `page_size` rows; the serializer trusts the
   *  cap. */
  fetchEntries(opts: {
    since?: number;
    until?: number;
    recipe_id?: string;
    page_size: number;
    cursor?: AuditExportCursor;
  }): Promise<AuditEntry[]>;

  /** Fetch every link row whose `memory_id` is in `runIds`. Adapter
   *  may bulk-fetch; the serializer fans the result into per-entry
   *  arrays. Empty / undefined when the entries set is empty. */
  fetchLinks(runIds: readonly string[]): Promise<AuditExportLinkRow[]>;

  /** Fetch the insight rows referenced by entries in this page (via
   *  `recipe_hash`). Adapter de-dupes against hashes already seen if
   *  the caller wants — the serializer also filters duplicates so it
   *  stays correct either way. */
  fetchInsights(hashes: readonly string[]): Promise<AuditExportInsightRow[]>;

  /** COUNT(*) over the request's filter, ignoring `cursor` /
   *  `page_size`. Used by `estimate` only. */
  count(opts: {
    since?: number;
    until?: number;
    recipe_id?: string;
  }): Promise<number>;
}

/** Identity inputs the serializer needs but that don't come from the
 *  request. Supplied by the caller (extension wires `scope: 'local'`
 *  + extension UUID; server wires `scope: 'server'` + pair-id). */
export interface AuditExportIdentity {
  instance_id: string;
  scope: 'local' | 'server';
  /** Override for tests. Defaults to `Date.now`. */
  now?: () => number;
}

const toIso = (epoch: number | undefined): string | null => {
  if (epoch === undefined) return null;
  if (!Number.isFinite(epoch)) return null;
  return new Date(epoch).toISOString();
};

const encodeCursor = (cursor: AuditExportCursor): string => {
  const json = JSON.stringify(cursor);
  // base64-url; mirrors `mcp.ts` cursor encoding to keep the two
  // paginated surfaces consistent.
  const utf8 = encodeURIComponent(json).replace(/%([0-9A-F]{2})/g, (_m, h) =>
    String.fromCharCode(parseInt(h, 16)),
  );
  return btoa(utf8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** Decode a wire cursor token. Returns null on malformed input — caller
 *  treats that as "ignore the cursor and start from the head" (matches
 *  `decodeTimelineCursor` semantics in `mcp.ts`). */
export const decodeAuditExportCursor = (
  raw: string | undefined,
): AuditExportCursor | null => {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? 0 : 4 - (normalized.length % 4);
  let json: string;
  try {
    const decoded = atob(normalized + '='.repeat(padding));
    const utf8 = decoded
      .split('')
      .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
      .join('');
    json = decodeURIComponent(utf8);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.last_started_at !== 'number' || !Number.isFinite(obj.last_started_at)) {
    return null;
  }
  if (typeof obj.last_run_id !== 'string') return null;
  return { last_started_at: obj.last_started_at, last_run_id: obj.last_run_id };
};

/** Translate a storage `AuditEntry` + its joined links into the wire
 *  `AuditExportEntry`. Pure shape adapter — no IO. Exposed so callers
 *  that need a per-entry preview (e.g. unit tests, debug surfaces)
 *  can build entries without going through the page serializer. */
export const buildExportEntry = (
  entry: AuditEntry,
  links: readonly AuditExportLinkRow[],
): AuditExportEntry => {
  const out: AuditExportEntry = {
    id: entry.run_id,
    recipe_id: entry.recipe_id,
    recipe_hash: entry.recipe_hash,
    started_at: entry.started_at,
    finished_at: entry.finished_at,
    duration_ms: entry.duration_ms,
    commit_status: entry.commit_status,
    trigger_source: entry.trigger_source,
    // ⚠ Coalesced so the EXPORT SHAPE is unchanged: the field became optional
    // on the entry, but an export consumer still gets an explicit null.
    trigger_url: entry.trigger_url ?? null,
    instance_id: entry.instance_id,
    config_snapshot: entry.config_snapshot,
    errors: (entry.errors ?? []).map((e) => ({
      code: e.code,
      ...(e.message ? { message: e.message } : {}),
      ...(e.source?.step_id ? { step_id: e.source.step_id } : {}),
    })),
    links: links.map((l) => ({
      entity_id: l.entity_id,
      kind: l.kind,
      ts: l.ts,
    })),
  };
  if (entry.process_id !== undefined) out.process_id = entry.process_id;
  if (entry.output_string !== undefined) out.output_string = entry.output_string;
  if (entry.recipe_insight_id !== undefined) {
    out.recipe_insight_id = entry.recipe_insight_id;
  }
  // D-153 P1.B — three-tier session ID pass-through.
  if (entry.channel_session_id !== undefined) {
    out.channel_session_id = entry.channel_session_id;
  }
  if (entry.cognition_session_id !== undefined) {
    out.cognition_session_id = entry.cognition_session_id;
  }
  if (entry.correlation_id !== undefined) {
    out.correlation_id = entry.correlation_id;
  }
  return out;
};

/** CSV escape — wraps in quotes when the value contains a comma /
 *  quote / newline; doubles internal quotes. Conservative: never under-
 *  quotes a value that might confuse a downstream parser. */
const csvEscape = (raw: unknown): string => {
  if (raw === null || raw === undefined) return '';
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
};

const CSV_HEADERS = [
  'id',
  'recipe_id',
  'recipe_hash',
  'started_at',
  'finished_at',
  'duration_ms',
  'commit_status',
  'trigger_source',
  'trigger_url',
  'instance_id',
  'process_id',
  'output_string',
  'errors',
  'links',
  // D-153 P1.B — three-tier session IDs at the end of the CSV so
  // existing column-order consumers keep working without a migration.
  'channel_session_id',
  'cognition_session_id',
  'correlation_id',
] as const;

const csvRow = (entry: AuditExportEntry): string =>
  [
    csvEscape(entry.id),
    csvEscape(entry.recipe_id),
    csvEscape(entry.recipe_hash),
    csvEscape(entry.started_at),
    csvEscape(entry.finished_at),
    csvEscape(entry.duration_ms),
    csvEscape(entry.commit_status),
    csvEscape(entry.trigger_source ?? ''),
    csvEscape(entry.trigger_url ?? ''),
    csvEscape(entry.instance_id ?? ''),
    csvEscape(entry.process_id ?? ''),
    csvEscape(entry.output_string ?? ''),
    csvEscape(entry.errors.map((e) => e.code).join(';')),
    // Links collapsed to a `;`-joined list of `<kind>:<entity_id>@<ts>`
    // tokens. Lossy by design — CSV is for spreadsheet import, not
    // round-trip; JSON/JSONL keep full structure.
    csvEscape(entry.links.map((l) => `${l.kind}:${l.entity_id}@${l.ts}`).join(';')),
    // D-153 P1.B — three-tier session IDs. Empty cells for legacy
    // rows that pre-date the engine substrate.
    csvEscape(entry.channel_session_id ?? ''),
    csvEscape(entry.cognition_session_id ?? ''),
    csvEscape(entry.correlation_id ?? ''),
  ].join(',');

const serializePageBody = (
  format: AuditExportFormat,
  entries: AuditExportEntry[],
  envelope: AuditExportEnvelope | undefined,
  isFirstPage: boolean,
): string => {
  if (format === 'json') {
    // Body is a JSON array fragment of entries. Consumer concatenates
    // pages with `,` between them and wraps with the envelope to
    // reconstruct the full archive.
    return entries.map((e) => JSON.stringify(e)).join(',');
  }
  if (format === 'jsonl') {
    const lines: string[] = [];
    if (isFirstPage && envelope) {
      lines.push(JSON.stringify({ _meta: envelope }));
    }
    for (const e of entries) lines.push(JSON.stringify(e));
    return lines.join('\n');
  }
  // CSV
  const lines: string[] = [];
  if (isFirstPage) lines.push(CSV_HEADERS.join(','));
  for (const e of entries) lines.push(csvRow(e));
  return lines.join('\n');
};

/** Cheap COUNT-only summary used to populate the dialog's live preview
 *  before the user commits to an export. The byte estimate uses a
 *  format-aware constant from contracts (`AUDIT_EXPORT_BYTES_PER_ENTRY`)
 *  multiplied by the count — ±10% accuracy is the design target. */
export const estimateExport = async (
  source: Pick<AuditExportSource, 'count'>,
  request: AuditExportRequest,
): Promise<AuditExportEstimate> => {
  const entry_count = await source.count({
    since: request.since,
    until: request.until,
    recipe_id: request.recipe_id,
  });
  const format = request.format ?? 'json';
  const perEntry = AUDIT_EXPORT_BYTES_PER_ENTRY[format];
  return { entry_count, estimated_bytes: entry_count * perEntry };
};

/** Build one page of the unified export. Caller drives pagination by
 *  re-issuing with the previous response's `next_cursor`. The first
 *  page (cursor undefined) carries the envelope; subsequent pages
 *  omit it.
 *
 *  Empty pages are valid — when `fetchEntries` returns nothing the
 *  function returns an empty body + no cursor, which the dialog
 *  treats as "we're done." */
export const exportPage = async (
  source: AuditExportSource,
  identity: AuditExportIdentity,
  request: AuditExportRequest,
): Promise<AuditExportPage> => {
  const format: AuditExportFormat = request.format ?? 'json';
  const pageSize = clampAuditExportPageSize(request.page_size);
  const cursor = decodeAuditExportCursor(request.cursor);
  const isFirstPage = cursor === null;

  const entries = await source.fetchEntries({
    since: request.since,
    until: request.until,
    recipe_id: request.recipe_id,
    page_size: pageSize,
    ...(cursor ? { cursor } : {}),
  });

  // Per-entry link join — bulk-fetch all links for this page's runIds,
  // then bucket into a map keyed by memory_id.
  const runIds = entries.map((e) => e.run_id);
  const linkRows = entries.length === 0 ? [] : await source.fetchLinks(runIds);
  const linksByRun = new Map<string, AuditExportLinkRow[]>();
  for (const row of linkRows) {
    const arr = linksByRun.get(row.memory_id);
    if (arr) arr.push(row);
    else linksByRun.set(row.memory_id, [row]);
  }

  const exportEntries = entries.map((e) =>
    buildExportEntry(e, linksByRun.get(e.run_id) ?? []),
  );

  // Envelope only on first page; recipe_insights deduped by hash.
  let envelope: AuditExportEnvelope | undefined;
  if (isFirstPage) {
    const hashes = Array.from(new Set(entries.map((e) => e.recipe_hash))).filter(
      (h): h is string => typeof h === 'string' && h.length > 0,
    );
    const insights = hashes.length > 0 ? await source.fetchInsights(hashes) : [];
    const recipe_insights: AuditExportEnvelope['recipe_insights'] = {};
    for (const ins of insights) {
      recipe_insights[ins.hash] = {
        slug: ins.slug,
        version: ins.version,
        flattened: ins.flattened,
      };
    }
    const now = (identity.now ?? Date.now)();
    envelope = {
      exported_at: new Date(now).toISOString(),
      instance_id: identity.instance_id,
      scope: identity.scope,
      since: toIso(request.since),
      until: toIso(request.until),
      recipe_filter: request.recipe_id ?? null,
      format,
      recipe_insights,
    };
  }

  const body = serializePageBody(format, exportEntries, envelope, isFirstPage);

  // Cursor: present iff this page filled completely (more rows may
  // exist). Equal-count is the standard pagination signal — any false
  // positive resolves on the next call when fetchEntries returns 0.
  let next_cursor: string | undefined;
  if (entries.length === pageSize) {
    const last = entries[entries.length - 1];
    next_cursor = encodeCursor({
      last_started_at: last.started_at,
      last_run_id: last.run_id,
    });
  }

  return {
    ...(envelope ? { envelope } : {}),
    body,
    entries_in_page: exportEntries.length,
    ...(next_cursor ? { next_cursor } : {}),
  };
};
