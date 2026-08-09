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
 *  Spec: D-198 §5 (list) + D-198 §B Slice 1. */

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

/** Strictly-after-cursor over the same order, on raw parts rather than an
 *  entry — the windowing loop compares tails and entries against one another. */
const afterCursor = (ts: number, id: string, cursor: MemoryCursor): boolean =>
  (ts !== cursor.ts ? ts < cursor.ts : id < cursor.id);

/** `compareEntriesDesc` over bare cursors: negative when `a` comes FIRST. */
const compareCursorsDesc = (a: MemoryCursor, b: MemoryCursor): number =>
  (b.ts - a.ts) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** The keyset position of a source's last returned row. Typed per source
 *  rather than through one `Record<string, unknown>` helper: a shared signature
 *  loose enough to accept both rows also accepts a row with NEITHER timestamp,
 *  and would silently take the `?? 0` branch — a horizon of 0 covers nothing and
 *  the loop would spin without advancing.
 *
 *  Both stores order by `COALESCE(event_at, <ingestion>) DESC, <id> DESC`,
 *  matching the union's `compareEntriesDesc` — if those orders ever drift apart
 *  the horizon stops bounding anything, which is why both `listWindow`
 *  implementations state their order in the same terms. */
const auditTailCursor = (row: AuditEntry): MemoryCursor =>
  ({ ts: row.event_at ?? row.started_at, id: row.run_id });

const userTailCursor = (row: UserMemoryRow): MemoryCursor =>
  ({ ts: row.event_at ?? row.ts, id: row.memory_id });

/** Rows per source per round. Above the default page size so the common
 *  unfiltered first page resolves in ONE round. */
const MEMORY_LIST_MIN_WINDOW = 128;
/** Ceiling on a single round's read, so a pathological filter cannot walk the
 *  whole table in one request. */
const MEMORY_LIST_MAX_WINDOW = 4096;
/** ⛔ A BOUND ON THE WALK, NOT ON THE ANSWER. A filter matching nothing for a
 *  very long stretch would otherwise page through the entire log inside one
 *  request. Stopping early can only return a SHORT page — never a wrong one —
 *  and the cursor still advances, so the client's next call resumes where this
 *  one stopped rather than losing the rows. */
const MEMORY_LIST_MAX_ROUNDS = 12;

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

  // ⛔ THE FEED IS PAGINATED, SO THE READ MUST BE TOO. This used to fetch
  // `listRecent(Number.MAX_SAFE_INTEGER)` — the ENTIRE audit log — plus the
  // ENTIRE `user_memory` store, project both, and slice 50 rows off the front.
  // Measured on real 698 B rows: 401ms and 393 MB of resident heap to render
  // ONE page at 200k entries, linear in the table. D-230 raised the audit
  // ceiling to 5 GB and left `user_memory` with no quota at all, so at the
  // prune trigger that page is ~5s and ~4.9 GB — the same shape that OOM'd the
  // harness at 3.1 GB. The old comment called the store "small next to the full
  // audit scan above", which was true and is the wrong comparison: both were
  // unbounded.
  //
  // 🔑 WHAT MOVES AND WHAT DOES NOT. Only ORDER + LIMIT + CURSOR go to SQL.
  // Every predicate stays in JS over the projected union exactly as before, so
  // the feed's semantics do not move — a `kind`/`since`/`until`/origin filter
  // still reads the projection, not the row. Getting pagination subtly wrong
  // shows up as duplicated or skipped entries, which is worse than slow.
  //
  // ⛔ THE HORIZON IS THE WHOLE CORRECTNESS ARGUMENT. Two sources are windowed
  // INDEPENDENTLY, so merging their tops is only trustworthy down to whichever
  // one ran out of window FIRST. Below that point the truncated source may hold
  // rows that belong ahead of rows the other source did supply, and taking the
  // naive merge would silently drop them. So each round keeps only entries at
  // or above `horizon` — the shallowest truncated tail — and re-enters from
  // there. When neither source filled its window nothing is truncated, the
  // horizon is unbounded, and the round is the last one.
  const store = deps.userMemoryStore;

  const collected: MemoryListEntry[] = [];
  let from: MemoryCursor | undefined = cursor;
  // One extra row is what tells `hasMore` from "exactly a full page".
  const want = limit + 1;
  let window = Math.max(want, MEMORY_LIST_MIN_WINDOW);
  let rounds = 0;
  /** True only when a round proved BOTH sources ran out. Anything else that
   *  ends the walk — a full page, the round cap — leaves rows below `from`. */
  let exhausted = false;

  while (collected.length < want) {
    // ⚠ A JS-side filter can reject an unbounded run of rows (a feed filtered
    // to `kind: 'note'` over a log of engine runs), so a fixed window would
    // return a short page that looks like the end of the feed. The window
    // grows per round instead, which turns a selective filter into a few
    // doubling reads rather than either a short page or a full scan.
    if (rounds >= MEMORY_LIST_MAX_ROUNDS) break;   // resumable; see below
    rounds += 1;

    const [auditRows, userRows] = await Promise.all([
      deps.auditLog.listWindow({ limit: window, ...(from ? { before: from } : {}) }),
      store !== undefined
        ? store.listWindow({ limit: window, ...(from ? { before: from } : {}) })
        : Promise.resolve([]),
    ]);

    // ⚠ A SHORT SOURCE CONTRIBUTES NO HORIZON — because it has nothing left to
    //   hide, not because including it would be wrong. Treating any non-empty
    //   source as a bound still returns the same rows (`from` advances to that
    //   tail and the next round picks up the remainder); it just spends an extra
    //   round doing it. Stated because a mutation flipping this to
    //   `length > 0` survives the suite, and that is the honest reason why.
    const auditFull = auditRows.length >= window;
    const userFull = userRows.length >= window;

    // Project to the wire shape FIRST, then filter over one basis — unchanged.
    const batch = [
      ...auditRows.map(auditRowToEntry),
      ...userRows.map(userRowToEntry),
    ].sort(compareEntriesDesc);

    // The shallowest truncated tail. `undefined` = neither source was cut off.
    const auditTail = auditFull ? auditTailCursor(auditRows[auditRows.length - 1]!) : undefined;
    const userTail = userFull ? userTailCursor(userRows[userRows.length - 1]!) : undefined;
    const horizon = auditTail === undefined ? userTail
      : userTail === undefined ? auditTail
        : (compareCursorsDesc(auditTail, userTail) <= 0 ? auditTail : userTail);

    const covered = horizon === undefined
      ? batch
      : batch.filter((e) => !afterCursor(entryEffectiveTs(e), e.memory_id, horizon));

    for (const e of covered) {
      if (origin_actors !== undefined && !origin_actors.includes(e.origin_actor)) continue;
      if (args.kind !== undefined && e.kind !== args.kind) continue;
      const et = entryEffectiveTs(e);
      if (typeof args.since === 'number' && et < args.since) continue;
      if (typeof args.until === 'number' && et > args.until) continue;
      collected.push(e);
    }

    if (horizon === undefined) { exhausted = true; break; }  // the real end
    from = horizon;
    window = Math.min(window * 2, MEMORY_LIST_MAX_WINDOW);
  }

  // ⚠ The origin filter is applied in JS above rather than passed to
  // `listWindow`. `listRecent`'s storage-level filter (D-161 P3) drops rows
  // BEFORE the slice, which is why it could not be windowed; re-applying the
  // same predicate over the union is what extends it to the store rows, so
  // filtering to `contracted_user` still surfaces both AI audit rows and
  // AI-written store rows.
  const page = collected.slice(0, limit);

  // ⛔ A TRUNCATED WALK MUST STILL HAND BACK A CURSOR. `hasMore` was
  // `collected.length > limit` alone, which is only honest when the walk
  // reached the end of the feed. Stop on the round cap with a short page and
  // that yields NO `next_cursor` — the client reads "end of feed" and every
  // matching row below the stopping point becomes unreachable, silently, for a
  // filter that may have hundreds of matches left. The round cap is supposed to
  // bound the WALK, not the ANSWER.
  const hasMore = collected.length > limit || (!exhausted && from !== undefined);

  // Redaction overlay (§5) — applied to the page only; `redactEntry` preserves
  // `memory_id` + effective time, so the cursor is unaffected.
  const redactedIds = await fetchRedactedIds(deps);
  const entries = redactedIds.size === 0
    ? page
    : page.map((e) => (redactedIds.has(e.memory_id) ? redactEntry(e) : e));

  const response: MemoryListResponse = { entries };
  if (collected.length > limit && page.length > 0) {
    // Rows were dropped from the tail of this page — resume at the last one
    // SERVED, not at the walk position, or the remainder is skipped.
    const last = page[page.length - 1]!;
    response.next_cursor = encodeCursor({ ts: entryEffectiveTs(last), id: last.memory_id });
  } else if (hasMore && from !== undefined) {
    // The round cap fired. Everything down to `from` is already in this page,
    // so resume at the walk position — which also skips re-scanning the
    // non-matching stretch the cap was hit on.
    response.next_cursor = encodeCursor(from);
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
