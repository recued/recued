/** D-198 Slice 1 — `memory.list` owner-trusted pair-RPC handler.
 *
 *  The transparent, origin-filterable feed backing the `#data` Memory lens.
 *  Whole-feed (NOT entity-scoped like `data.timeline`): lists the D-120
 *  `data.memory.*` provenance rows newest-first, filtered by write-actor
 *  (You / AI / each contract), paginated by opaque cursor. Owner-trusted —
 *  bearer-`user_self`, registered-client boundary, NO contract/egress gate
 *  (mirrors `data.timeline` / `data.file.read`); the transport still audits.
 *
 *  Reuses the storage `listRecent(limit, { origin_actors })` origin filter
 *  (D-161 P3) rather than adding an `AuditLogStore` method (40+ consumers);
 *  the kind / since / until predicates + cursor pagination run in the handler
 *  over the already-materialized matched set. Read-only. Slice 1 wires
 *  `memory.list` only; create/update/delete/import land in Slice 2+.
 *
 *  Spec: docs/d-198-spec.md §5 (list) + docs/d-198-build-plan.md §B Slice 1. */

import {
  RpcError,
  isActor,
  MEMORY_LIST_DEFAULT_PAGE_SIZE,
  MEMORY_LIST_MAX_PAGE_SIZE,
  type Actor,
  type HandlerSlice,
  type MemoryCreateRequest,
  type MemoryDeleteRequest,
  type MemoryDeleteResult,
  type MemoryGetRequest,
  type MemoryGetResponse,
  type MemoryImportEntry,
  type MemoryImportRequest,
  type MemoryImportResult,
  type MemoryListEntry,
  type MemoryListRequest,
  type MemoryListResponse,
  type MemoryMutationResult,
  type MemoryUpdateRequest,
  type ServerRpcRegistry,
} from '@recued/contracts';
import type { AuditEntry, AuditLogStore, Collection } from '@recued/storage';
import type { EventBus } from './events/bus.js';
import { emitMemoryUser } from './events/emit-sites.js';
import {
  USER_MEMORY_ID_PREFIX,
  type UserMemoryCreateInput,
  type UserMemoryImportEntry,
  type UserMemoryRow,
  type UserMemoryStore,
  type UserMemoryUpdateInput,
} from './user-memory-store.js';
import type { WsClient } from './ws-server.js';

/** D-198 Slice 4 — a redaction marker (§5). The owner "forgets" a non-`user_self`
 *  row (engine / AI / contracted) by RECORDING a redaction here, never mutating
 *  the source row — so the signed audit log stays intact. `memory.list` /
 *  `memory.get` overlay it at read time: the row still displays (transparency),
 *  content-cleared + `redacted: true`, origin + timestamps retained. */
export interface MemoryRedactionRecord {
  memory_id: string;
  redacted_at: number;
}

export interface MemoryRpcDeps {
  auditLog: AuditLogStore;
  /** D-198 Slice 2 — the owner-authored `user_memory` store. Absent → the
   *  write ops report `not_configured` and the feed is audit-only. */
  userMemoryStore?: UserMemoryStore;
  /** D-198 Slice 4 — the redaction-marker store (overlay). Absent → redacting a
   *  non-`user_self` row reports `not_configured`. */
  redactionStore?: Collection<MemoryRedactionRecord>;
  /** Realtime broadcast bus. Owner create/update/delete fan a `memory` event
   *  so paired Memory lenses silently refresh. Best-effort (may be absent). */
  bus?: EventBus;
  /** Injected clock (tests pass a fixed value). Default `Date.now`. */
  now?: () => number;
}

/** Registered-client boundary. The owner-trusted read runs WITHOUT a
 *  contract/egress gate (mirrors `data.timeline`), so an actual paired-UI
 *  boundary MUST enforce that only the owner reaches it — an unregistered /
 *  legacy raw-bearer WS caller is rejected before the query runs. */
const requireRegisteredClient = (client: WsClient): void => {
  if (!client.instance_id) {
    throw new RpcError(
      'unauthorized',
      'memory.list requires a registered paired client',
      401,
    );
  }
};

interface MemoryCursor {
  ts: number;
  id: string;
}

const encodeCursor = (c: MemoryCursor): string =>
  Buffer.from(JSON.stringify(c), 'utf8').toString('base64');

const decodeCursor = (raw: string | undefined): MemoryCursor | undefined => {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    if (
      parsed !== null
      && typeof parsed === 'object'
      && typeof (parsed as MemoryCursor).ts === 'number'
      && typeof (parsed as MemoryCursor).id === 'string'
    ) {
      return { ts: (parsed as MemoryCursor).ts, id: (parsed as MemoryCursor).id };
    }
  } catch {
    /* malformed cursor → start from the top (fail-open on a read) */
  }
  return undefined;
};

const clampLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return MEMORY_LIST_DEFAULT_PAGE_SIZE;
  }
  return Math.min(Math.floor(limit), MEMORY_LIST_MAX_PAGE_SIZE);
};

const sanitizeActors = (actors: Actor[] | undefined): Actor[] | undefined => {
  if (!Array.isArray(actors) || actors.length === 0) return undefined;
  const valid = actors.filter((a): a is Actor => isActor(a));
  return valid.length > 0 ? valid : undefined;
};

/** Effective (bistemporal) time for since/until + ordering — real-world
 *  event time when present, else ingestion time (COALESCE(event_at, ts)),
 *  matching the D-120 timeline event-axis default. Runs over the PROJECTED
 *  wire entry so the audit + user sources sort against one basis. */
const entryEffectiveTs = (e: MemoryListEntry): number => e.event_at ?? e.ts;

/** Deterministic total order across the union: newest-first by effective
 *  time, `memory_id` DESC tiebreak so the opaque cursor is stable across
 *  equal timestamps (audit `run_id`s and `umem_*` ids share the key space
 *  but never collide — distinct domains). */
const compareEntriesDesc = (a: MemoryListEntry, b: MemoryListEntry): number => {
  const dt = entryEffectiveTs(b) - entryEffectiveTs(a);
  if (dt !== 0) return dt;
  return a.memory_id < b.memory_id ? 1 : a.memory_id > b.memory_id ? -1 : 0;
};

/** Strictly-after-cursor predicate over the `compareEntriesDesc` total order. */
const afterCursorEntry = (e: MemoryListEntry, cursor: MemoryCursor): boolean => {
  const et = entryEffectiveTs(e);
  if (et !== cursor.ts) return et < cursor.ts;
  return e.memory_id < cursor.id;
};

/** Project a stored audit/memory row onto the wire shape. `body_preview` /
 *  `reason_code` stay absent for engine/AI-authored audit rows (they carry
 *  no user payload); the feed surfaces origin + kind + summary + time +
 *  the run link, and shows EVERY origin (D-198 §3 transparency). */
const auditRowToEntry = (e: AuditEntry): MemoryListEntry => {
  const entry: MemoryListEntry = {
    memory_id: e.run_id,
    origin_actor: e.execution_source?.actor ?? 'system',
    kind: e.commit_kind ?? 'run',
    ts: e.started_at,
    run_id: e.run_id,
  };
  if (typeof e.output_string === 'string') entry.summary = e.output_string;
  if (typeof e.event_at === 'number') entry.event_at = e.event_at;
  return entry;
};

/** Project an owner-authored `user_memory` row onto the wire shape. Carries
 *  the denormalized `body_preview` + `size_bytes` + `has_body` so the feed
 *  never resolves the inline/blob body (§5); the full body loads via
 *  `memory.get`. Always `user_self` ("You"). */
const userRowToEntry = (r: UserMemoryRow): MemoryListEntry => {
  const entry: MemoryListEntry = {
    memory_id: r.memory_id,
    origin_actor: r.origin_actor,
    kind: r.kind,
    ts: r.ts,
    size_bytes: r.size_bytes,
    has_body: r.size_bytes > 0,
  };
  if (r.summary !== undefined) entry.summary = r.summary;
  if (r.body_preview !== undefined) entry.body_preview = r.body_preview;
  if (r.reason_code !== undefined) entry.reason_code = r.reason_code;
  if (r.event_at !== undefined) entry.event_at = r.event_at;
  if (r.provenance_entity_ids !== undefined && r.provenance_entity_ids.length > 0) {
    entry.links = r.provenance_entity_ids.map((entity_id) => ({
      entity_id,
      kind: 'provenance',
      ts: r.ts,
    }));
  }
  return entry;
};

const EMPTY_REDACTED: ReadonlySet<string> = new Set();

/** The set of redacted memory_ids (empty when no redaction store is wired). */
const fetchRedactedIds = async (deps: MemoryRpcDeps): Promise<ReadonlySet<string>> => {
  if (!deps.redactionStore) return EMPTY_REDACTED;
  const records = await deps.redactionStore.list();
  return new Set(records.map((r) => r.memory_id));
};

/** Overlay a redaction (§5): the row still displays (transparency), but with its
 *  content cleared + `redacted: true`; origin / kind / time / run link survive so
 *  the timeline stays honest. Never mutates the source row. */
const redactEntry = (e: MemoryListEntry): MemoryListEntry => {
  const entry: MemoryListEntry = {
    memory_id: e.memory_id,
    origin_actor: e.origin_actor,
    kind: e.kind,
    ts: e.ts,
    redacted: true,
  };
  if (e.event_at !== undefined) entry.event_at = e.event_at;
  if (e.run_id !== undefined) entry.run_id = e.run_id;
  return entry;
};

export const handleMemoryList = async (
  deps: MemoryRpcDeps,
  args: MemoryListRequest,
): Promise<MemoryListResponse> => {
  const limit = clampLimit(args.limit);
  const origin_actors = sanitizeActors(args.origin_actors);
  const cursor = decodeCursor(args.cursor);

  // Reuse the storage origin filter (D-161 P3). A MAX slice returns every
  // matched row (the store materializes all rows internally regardless).
  const auditRows = await deps.auditLog.listRecent(Number.MAX_SAFE_INTEGER, {
    ...(origin_actors ? { origin_actors } : {}),
  });

  // UNION in the `user_memory` store rows. The store holds owner-authored
  // `user_self` rows AND (D-198 Slice 4) `contracted_user` AI/customer writes,
  // so fetch whenever the store exists — the origin filter is applied over the
  // union below (a store-level `user_self`-only short-circuit would hide the
  // contracted_user rows the "AI" origin filter must surface). "One pool" (§2)
  // = this read union; the audit log stays a pure run record. The store list is
  // small (owner notes + AI writes) next to the full audit scan above.
  const userRows = deps.userMemoryStore !== undefined
    ? await deps.userMemoryStore.list()
    : [];

  // Project both sources to the wire shape FIRST, then filter / sort / paginate
  // over one basis (`kind` + effective-time filters read the projection, so the
  // audit-only path stays byte-identical to Slice 1a).
  const all: MemoryListEntry[] = [
    ...auditRows.map(auditRowToEntry),
    ...userRows.map(userRowToEntry),
  ];

  const filtered = all.filter((e) => {
    // Origin filter over the UNION. The audit source is already pre-filtered by
    // `listRecent(origin_actors)`; re-applying here (harmless for audit rows)
    // extends the SAME filter to the store rows — so filtering to `contracted_user`
    // surfaces both AI audit rows and AI-written store rows.
    if (origin_actors !== undefined && !origin_actors.includes(e.origin_actor)) return false;
    if (args.kind !== undefined && e.kind !== args.kind) return false;
    const et = entryEffectiveTs(e);
    if (typeof args.since === 'number' && et < args.since) return false;
    if (typeof args.until === 'number' && et > args.until) return false;
    return true;
  });

  filtered.sort(compareEntriesDesc);

  const afterCur = cursor ? filtered.filter((e) => afterCursorEntry(e, cursor)) : filtered;
  const page = afterCur.slice(0, limit);
  const hasMore = afterCur.length > limit;

  // Redaction overlay (§5) — applied to the page only; `redactEntry` preserves
  // `memory_id` + effective time, so the cursor is unaffected.
  const redactedIds = await fetchRedactedIds(deps);
  const entries = redactedIds.size === 0
    ? page
    : page.map((e) => (redactedIds.has(e.memory_id) ? redactEntry(e) : e));

  const response: MemoryListResponse = { entries };
  if (hasMore && page.length > 0) {
    const last = page[page.length - 1]!;
    response.next_cursor = encodeCursor({ ts: entryEffectiveTs(last), id: last.memory_id });
  }
  return response;
};

/** Coerce a request body (`unknown`) to a stored string. A string rides
 *  verbatim (empty → body-less); anything else JSON-serializes (the future
 *  import path carries structured payloads). null/undefined → body-less. */
const coerceBody = (body: unknown): string | undefined => {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body.length > 0 ? body : undefined;
  try {
    return JSON.stringify(body);
  } catch {
    return undefined;
  }
};

const coerceOptionalString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : value === undefined ? undefined : String(value);

const sanitizeIds = (ids: unknown): string[] =>
  Array.isArray(ids)
    ? ids.filter((x): x is string => typeof x === 'string' && x.length > 0)
    : [];

/** Route an id to its store by domain prefix (§2). Owner-authored rows carry
 *  the `umem_` prefix; anything else is a D-120 audit `run_id`. */
const isUserMemoryId = (memory_id: string): boolean =>
  memory_id.startsWith(USER_MEMORY_ID_PREFIX);

/** `memory.get` — resolve ONE entry's full body for the detail view (the feed
 *  ships only `body_preview`, §5). Owner rows resolve inline/CAS from the
 *  `user_memory` store; audit rows resolve from the audit log and carry no
 *  body (only `summary`). */
/** Strip content from a resolved entry for a redacted row (§5): summary / body /
 *  size go; origin / kind / time / reason / run link stay. */
const redactGetResponse = (res: MemoryGetResponse): MemoryGetResponse => {
  const out: MemoryGetResponse = {
    memory_id: res.memory_id,
    origin_actor: res.origin_actor,
    kind: res.kind,
    ts: res.ts,
    redacted: true,
  };
  if (res.event_at !== undefined) out.event_at = res.event_at;
  if (res.run_id !== undefined) out.run_id = res.run_id;
  if (res.reason_code !== undefined) out.reason_code = res.reason_code;
  return out;
};

export const handleMemoryGet = async (
  deps: MemoryRpcDeps,
  args: MemoryGetRequest,
): Promise<MemoryGetResponse> => {
  const memory_id = args.memory_id;
  if (typeof memory_id !== 'string' || memory_id.length === 0) {
    throw new RpcError('bad_request', 'memory.get requires a memory_id', 400);
  }

  const isRedacted = deps.redactionStore
    ? (await deps.redactionStore.get(memory_id)) !== null
    : false;

  let res: MemoryGetResponse;
  if (deps.userMemoryStore && isUserMemoryId(memory_id)) {
    const resolved = await deps.userMemoryStore.get(memory_id);
    if (resolved === null) throw new RpcError('not_found', 'memory entry not found', 404);
    const { row, body } = resolved;
    res = {
      memory_id: row.memory_id,
      origin_actor: row.origin_actor,
      kind: row.kind,
      ts: row.ts,
      size_bytes: row.size_bytes,
    };
    if (row.summary !== undefined) res.summary = row.summary;
    if (body !== undefined) res.body = body;
    if (row.reason_code !== undefined) res.reason_code = row.reason_code;
    if (row.event_at !== undefined) res.event_at = row.event_at;
  } else {
    const audit = await deps.auditLog.get(memory_id);
    if (audit === null) throw new RpcError('not_found', 'memory entry not found', 404);
    res = {
      memory_id: audit.run_id,
      origin_actor: audit.execution_source?.actor ?? 'system',
      kind: audit.commit_kind ?? 'run',
      ts: audit.started_at,
      run_id: audit.run_id,
    };
    if (typeof audit.output_string === 'string') res.summary = audit.output_string;
    if (typeof audit.event_at === 'number') res.event_at = audit.event_at;
    // Audit rows carry no user body — only the summary (§5).
  }

  return isRedacted ? redactGetResponse(res) : res;
};

/** `memory.create` — author a NEW `user_self` entry. The origin is stamped
 *  SERVER-SIDE (`user_self`), never from the request: the origin-honesty
 *  invariant (§3) forbids a caller minting a row of another origin. */
export const handleMemoryCreate = async (
  deps: MemoryRpcDeps,
  args: MemoryCreateRequest,
): Promise<MemoryMutationResult> => {
  if (!deps.userMemoryStore) {
    throw new RpcError('not_configured', 'memory.create requires the user_memory store', 501);
  }
  if (typeof args.kind !== 'string' || args.kind.trim().length === 0) {
    throw new RpcError('bad_request', 'memory.create requires a non-empty kind', 400);
  }

  const input: UserMemoryCreateInput = { kind: args.kind };
  const summary = coerceOptionalString(args.summary);
  if (summary !== undefined) input.summary = summary;
  const body = coerceBody(args.body);
  if (body !== undefined) input.body = body;
  const reason_code = coerceOptionalString(args.reason_code);
  if (reason_code !== undefined) input.reason_code = reason_code;
  if (typeof args.event_at === 'number') input.event_at = args.event_at;
  const ids = sanitizeIds(args.provenance_entity_ids);
  if (ids.length > 0) input.provenance_entity_ids = ids;

  const row = await deps.userMemoryStore.create(input);
  emitMemoryUser(deps.bus, row.memory_id);
  return { memory_id: row.memory_id, provenance_edges_written: ids.length };
};

/** `memory.update` — edit the caller's OWN `user_self` entry. Only owner rows
 *  are mutable (§3); an audit-row id is rejected (view + redact only). Origin
 *  is never patchable — `update` cannot touch it. */
export const handleMemoryUpdate = async (
  deps: MemoryRpcDeps,
  args: MemoryUpdateRequest,
): Promise<MemoryMutationResult> => {
  const memory_id = args.memory_id;
  if (typeof memory_id !== 'string' || memory_id.length === 0) {
    throw new RpcError('bad_request', 'memory.update requires a memory_id', 400);
  }
  if (!isUserMemoryId(memory_id)) {
    throw new RpcError('unsupported', 'only your own memory (user_self) is editable', 409);
  }
  if (!deps.userMemoryStore) {
    throw new RpcError('not_configured', 'memory.update requires the user_memory store', 501);
  }

  const patch: UserMemoryUpdateInput = {};
  const kind = coerceOptionalString(args.kind);
  if (kind !== undefined) patch.kind = kind;
  const summary = coerceOptionalString(args.summary);
  if (summary !== undefined) patch.summary = summary;
  // A present `body` REPLACES it (empty clears); an absent `body` leaves it.
  if (args.body !== undefined) patch.body = coerceBody(args.body) ?? '';
  if (typeof args.event_at === 'number') patch.event_at = args.event_at;

  const row = await deps.userMemoryStore.update(memory_id, patch);
  if (row === null) throw new RpcError('not_found', 'memory entry not found', 404);
  emitMemoryUser(deps.bus, memory_id);
  return { memory_id, provenance_edges_written: row.provenance_entity_ids?.length ?? 0 };
};

/** `memory.delete` — origin-split (§5): the owner's own `user_self` rows
 *  HARD-delete; every other origin (engine / AI / contracted) is REDACTED, not
 *  deleted — a redaction marker is recorded and `memory.list` / `memory.get`
 *  overlay it (content cleared, origin + provenance skeleton retained). The
 *  source row is never mutated, so the signed audit log stays intact.
 *
 *  Slice 4 — the `user_memory` store now also holds `contracted_user` rows (AI /
 *  customer writes, all `umem_`), so the split is by the ROW's real
 *  `origin_actor`, NOT the id prefix: a `umem_` row is hard-deleted only when it
 *  is `user_self`; a `contracted_user` store row redacts like an audit row. */
export const handleMemoryDelete = async (
  deps: MemoryRpcDeps,
  args: MemoryDeleteRequest,
): Promise<MemoryDeleteResult> => {
  const memory_id = args.memory_id;
  if (typeof memory_id !== 'string' || memory_id.length === 0) {
    throw new RpcError('bad_request', 'memory.delete requires a memory_id', 400);
  }

  // Redact (non-`user_self`): record a marker; `list`/`get` overlay it. Never
  // mutates the source row (audit authority + origin-honesty, §3).
  const redact = async (): Promise<MemoryDeleteResult> => {
    if (!deps.redactionStore) {
      throw new RpcError('not_configured', 'memory.delete requires the redaction store', 501);
    }
    const now = (deps.now ?? Date.now)();
    await deps.redactionStore.set(memory_id, { memory_id, redacted_at: now });
    emitMemoryUser(deps.bus, memory_id);
    return { memory_id, deleted: false, redacted: true };
  };

  // `umem_` store rows split by the ROW's real origin (§3): `user_self` hard-
  // deletes (cascades its body blob); a `contracted_user` AI/customer write is
  // redacted, never hard-deleted — origin + provenance survive.
  if (isUserMemoryId(memory_id)) {
    if (!deps.userMemoryStore) {
      throw new RpcError('not_configured', 'memory.delete requires the user_memory store', 501);
    }
    const resolved = await deps.userMemoryStore.get(memory_id);
    if (resolved === null) throw new RpcError('not_found', 'memory entry not found', 404);
    if (resolved.row.origin_actor !== 'user_self') return redact();
    const deleted = await deps.userMemoryStore.delete(memory_id);
    if (!deleted) throw new RpcError('not_found', 'memory entry not found', 404);
    emitMemoryUser(deps.bus, memory_id);
    return { memory_id, deleted: true, redacted: false };
  }

  // Audit row (engine / AI / contracted) → redact. Verify it exists first (404
  // on an unknown id).
  const audit = await deps.auditLog.get(memory_id);
  if (audit === null) throw new RpcError('not_found', 'memory entry not found', 404);
  return redact();
};

/** `memory.import` — bulk restore / ingest into the `user_memory` store (§5).
 *  Origin-split on the dedup key: `user_self` entries merge-by-`memory_id`
 *  (idempotent restore of your own); "other" entries content-dedup and land
 *  owner-VOUCHED (stored `user_self`, stamped `imported`) — no entry can mint a
 *  row that reads as another origin (origin-honesty, §3). */
export const handleMemoryImport = async (
  deps: MemoryRpcDeps,
  args: MemoryImportRequest,
): Promise<MemoryImportResult> => {
  if (!deps.userMemoryStore) {
    throw new RpcError('not_configured', 'memory.import requires the user_memory store', 501);
  }
  if (!Array.isArray(args.entries)) {
    throw new RpcError('bad_request', 'memory.import requires an entries array', 400);
  }

  const entries: UserMemoryImportEntry[] = args.entries.map((raw: MemoryImportEntry) => {
    const entry: UserMemoryImportEntry = {
      origin_actor: typeof raw.origin_actor === 'string' ? raw.origin_actor : 'system',
      // A blank kind is rejected per-entry by the store (counted `skipped`).
      kind: typeof raw.kind === 'string' ? raw.kind : '',
    };
    if (typeof raw.memory_id === 'string') entry.memory_id = raw.memory_id;
    const summary = coerceOptionalString(raw.summary);
    if (summary !== undefined) entry.summary = summary;
    const body = coerceBody(raw.body);
    if (body !== undefined) entry.body = body;
    const reason_code = coerceOptionalString(raw.reason_code);
    if (reason_code !== undefined) entry.reason_code = reason_code;
    if (typeof raw.ts === 'number') entry.ts = raw.ts;
    if (typeof raw.event_at === 'number') entry.event_at = raw.event_at;
    const ids = sanitizeIds(raw.provenance_entity_ids);
    if (ids.length > 0) entry.provenance_entity_ids = ids;
    return entry;
  });

  const result = await deps.userMemoryStore.import(entries);
  // Any write fans a single `memory` refresh (the feed re-reads the whole pool).
  if (result.merged + result.inserted > 0) emitMemoryUser(deps.bus, 'import');
  return result;
};

type MemoryRpcMethods =
  | 'memory.list'
  | 'memory.get'
  | 'memory.create'
  | 'memory.update'
  | 'memory.delete'
  | 'memory.import';

export const makeMemoryRpcHandlers = (
  deps: MemoryRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, MemoryRpcMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  // Registered-client gate at every slice arrow (enforces the owner-only
  // boundary the no-contract-gate read/write relies on).
  return {
    methods: ['memory.list', 'memory.get', 'memory.create', 'memory.update', 'memory.delete', 'memory.import'],
    handlers: {
      'memory.list': async (args, client) => {
        requireRegisteredClient(client);
        return handleMemoryList(deps, args as MemoryListRequest);
      },
      'memory.get': async (args, client) => {
        requireRegisteredClient(client);
        return handleMemoryGet(deps, args as MemoryGetRequest);
      },
      'memory.create': async (args, client) => {
        requireRegisteredClient(client);
        return handleMemoryCreate(deps, args as MemoryCreateRequest);
      },
      'memory.update': async (args, client) => {
        requireRegisteredClient(client);
        return handleMemoryUpdate(deps, args as MemoryUpdateRequest);
      },
      'memory.delete': async (args, client) => {
        requireRegisteredClient(client);
        return handleMemoryDelete(deps, args as MemoryDeleteRequest);
      },
      'memory.import': async (args, client) => {
        requireRegisteredClient(client);
        return handleMemoryImport(deps, args as MemoryImportRequest);
      },
    },
  };
};
