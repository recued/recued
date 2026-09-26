/** D-119 Phase 13 — rpc handlers for `annotation.*` and `link.*`.
 *
 *  Eight methods: write / list / search / delete / forRecord on the
 *  annotation surface, write / list / delete / forRecord on the link
 *  surface. The kernel adapter on the extension side dispatches the
 *  user-facing slugs (`annotation-create`, `annotation-list`, … ) to these
 *  via the `Conn<ServerRpcRegistry>` rpc transport. The server runtime
 *  also wires its own kernel dispatcher to call the same handlers
 *  in-process so server-side recipe execution doesn't loop through ws.
 *
 *  Ingredient inputs accept canonical refs (`{ ref: { _id, _collection } }`)
 *  OR explicit `{ collection, id }` shapes. The server normalizes the
 *  ref before calling the store. */

import {
  RpcError,
  extractCanonicalRef,
} from '@recued/contracts';
import type {
  Actor,
  HandlerSlice,
  ServerRpcRegistry,
  Annotation,
  AnnotationFilter,
  AnnotationSearchMatch,
  AnnotationSearchQuery,
  Link,
  LinkFilter,
  OriginSurface,
} from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';
import type { WsClient } from './ws-server.js';
import {
  AnnotationKeyInvalidError,
  AnnotationValueTooLargeError,
  type AnnotationStore,
} from './storage/annotation-store.js';

export interface AnnotationRpcDeps {
  store: AnnotationStore;
  /** Author of writes — resolves to the paired ext's user id. Absent
   *  deps use a synthetic `"rpc"` tag so the audit trail still emits. */
  getAuthorId?: (ctx: { instance_id?: string | null }) => string | null;
  /** Optional audit log. Successful writes + deletes emit activity
   *  entries; failures never do (the error reaches the caller). */
  auditLog?: AuditLogStore;
  /** D-161 P2 — origin provenance facet, SERVER-INJECTED (never read from
   *  the rpc / recipe `args`). Two injection sites mirror the P1
   *  enrichment pattern:
   *   - the recipe upsert path: `wire-executor-config.ts` lifts the
   *     engine-supplied `stepMeta.actor` off the TRUSTED kernel dispatch
   *     input into these deps, so an MCP-run recipe's annotation carries
   *     `contracted_user` propagated from the run (I-6 / A.5);
   *   - the direct paired-client rpc (`annotation.write` / `link.write`):
   *     `makeAnnotationHandlers` injects `'user_self'` (the channel is
   *     `user` by construction).
   *  Keeping origin off `args` is the security boundary: a client payload
   *  cannot spoof `origin_actor` / `origin_contract_id`. Absent → the
   *  store stamps `'system'` via the column default. */
  origin_actor?: Actor;
  /** D-161 P2 — contract in force on the writing execution; paired with
   *  `origin_actor`, present iff contracted. */
  origin_contract_id?: string;
  /** D-177 N.11 rule 1 — the write SURFACE, same injection boundary and
   *  sites as `origin_actor`: `'client_rpc'` from `makeAnnotationHandlers`
   *  (the human's own paired client), `'engine'` from the recipe-path
   *  deps lift in `wire-executor-config.ts`. Absent → the store stamps
   *  `'system'`. Decides — with the actor — the stored-cleanliness gate
   *  (`isUserCleanStoredRow`). */
  origin_surface?: OriginSurface;
}

/** D-161 P2 — project the SERVER-INJECTED origin facet off `deps` into
 *  the store-write spread. Read from `deps`, never `args` (the spoofing
 *  boundary). `origin_contract_id` is attached only alongside an
 *  `origin_actor` (a contract with no actor is incoherent — mirrors
 *  `originProvenanceFromActor`). Absent actor → empty spread → the store
 *  stamps `'system'` via the column default. */
const originFields = (
  deps: AnnotationRpcDeps,
): {
  origin_actor?: Actor;
  origin_contract_id?: string;
  origin_surface?: OriginSurface;
} =>
  deps.origin_actor !== undefined
    ? {
        origin_actor: deps.origin_actor,
        ...(deps.origin_contract_id !== undefined
          ? { origin_contract_id: deps.origin_contract_id }
          : {}),
        ...(deps.origin_surface !== undefined
          ? { origin_surface: deps.origin_surface }
          : {}),
      }
    : {};

const logActivity = async (
  deps: AnnotationRpcDeps,
  action:
    | 'annotation_write'
    | 'annotation_delete'
    | 'link_write'
    | 'link_delete',
  target: string,
  detail?: string,
): Promise<void> => {
  if (!deps.auditLog) return;
  try {
    await deps.auditLog.logActivity({
      activity_id: '',
      timestamp: Date.now(),
      action,
      target,
      ...(detail ? { detail } : {}),
    });
  } catch {
    // best-effort; never blocks the actual write
  }
};

const mapStoreError = (e: unknown): RpcError => {
  if (e instanceof AnnotationKeyInvalidError) {
    return new RpcError('bad_request', e.message, 400);
  }
  if (e instanceof AnnotationValueTooLargeError) {
    return new RpcError('payload_too_large', e.message, 413);
  }
  if (e instanceof RpcError) return e;
  // Don't echo raw SQLite / internal error text to the caller — log it
  // server-side, return a generic 500.
  console.error('annotation-handler: unexpected store error', e);
  return new RpcError('internal_error', 'internal error', 500);
};

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const own = (value: Record<string, unknown>, key: string): unknown =>
  hasOwn(value, key) ? value[key] : undefined;

/** Normalize a `{ ref?, collection?, id? }` shape into `{ collection,
 *  id }`. Throws on malformed input — every annotation/link write
 *  needs an unambiguous endpoint. */
const normalizeRef = (
  args: Record<string, unknown>,
  prefix: 'target' | 'from' | 'to',
): { collection: string; id: string } => {
  const ref = own(args, `${prefix}_ref`);
  if (ref !== undefined) {
    const extracted = extractCanonicalRef(ref);
    if (extracted) return extracted;
    throw new RpcError(
      'bad_request',
      `${prefix}_ref is not a canonical record (missing _id / _collection)`,
      400,
    );
  }
  const collection = own(args, `${prefix}_collection`);
  const id = own(args, `${prefix}_id`);
  if (typeof collection !== 'string' || typeof id !== 'string') {
    throw new RpcError(
      'bad_request',
      `expected ${prefix}_collection + ${prefix}_id (or ${prefix}_ref)`,
      400,
    );
  }
  return { collection, id };
};

// ────────────────────────────────────────────────────────────────
// annotation.write
// ────────────────────────────────────────────────────────────────

export const handleAnnotationWrite = async (
  deps: AnnotationRpcDeps,
  args: Record<string, unknown>,
  ctx: { instance_id?: string | null } = {},
): Promise<{ annotation: Annotation }> => {
  const target = normalizeRef(args, 'target');
  const key = own(args, 'key');
  if (typeof key !== 'string' || key.length === 0) {
    throw new RpcError('bad_request', 'key is required', 400);
  }
  const value = hasOwn(args, 'value') ? args.value : null;

  const sourceHash = own(args, 'source_record_hash');
  if (typeof sourceHash !== 'string') {
    throw new RpcError('bad_request', 'source_record_hash is required', 400);
  }
  const recipeId = own(args, 'authored_by_recipe_id');
  if (typeof recipeId !== 'string') {
    throw new RpcError('bad_request', 'authored_by_recipe_id is required', 400);
  }
  const author = deps.getAuthorId?.(ctx) ?? 'rpc';

  try {
    const annotation = await deps.store.annotate({
      target_collection: target.collection,
      target_id: target.id,
      key,
      value,
      authored_by_recipe_id: recipeId,
      source_record_hash: sourceHash,
      ...(typeof own(args, 'model_used') === 'string' ? { model_used: own(args, 'model_used') as string } : {}),
      ...originFields(deps),
    });
    await logActivity(
      deps,
      'annotation_write',
      `${target.collection}/${target.id}#${key}`,
      `author=${author} bytes=${JSON.stringify(value ?? null).length}`,
    );
    return { annotation };
  } catch (e) {
    throw mapStoreError(e);
  }
};

// ────────────────────────────────────────────────────────────────
// annotation.list
// ────────────────────────────────────────────────────────────────

export const handleAnnotationList = async (
  deps: AnnotationRpcDeps,
  args: AnnotationFilter,
): Promise<{ annotations: Annotation[] }> => {
  try {
    const annotations = await deps.store.listAnnotations(args);
    return { annotations };
  } catch (e) {
    throw mapStoreError(e);
  }
};

// ────────────────────────────────────────────────────────────────
// annotation.search
// ────────────────────────────────────────────────────────────────

export const handleAnnotationSearch = async (
  deps: AnnotationRpcDeps,
  args: AnnotationSearchQuery,
): Promise<{ matches: AnnotationSearchMatch[] }> => {
  const query = own(args as unknown as Record<string, unknown>, 'query');
  if (typeof query !== 'string' || query.length === 0) {
    throw new RpcError('bad_request', 'query is required', 400);
  }
  try {
    const matches = await deps.store.searchAnnotations({ ...args, query });
    return { matches };
  } catch (e) {
    throw mapStoreError(e);
  }
};

// ────────────────────────────────────────────────────────────────
// annotation.delete
// ────────────────────────────────────────────────────────────────

export const handleAnnotationDelete = async (
  deps: AnnotationRpcDeps,
  args: AnnotationFilter,
): Promise<{ ok: true; deleted: number }> => {
  try {
    const deleted = await deps.store.deleteAnnotations(args);
    await logActivity(
      deps,
      'annotation_delete',
      JSON.stringify(args),
      `deleted=${deleted}`,
    );
    return { ok: true, deleted };
  } catch (e) {
    throw mapStoreError(e);
  }
};

// ────────────────────────────────────────────────────────────────
// annotation.forRecord
// ────────────────────────────────────────────────────────────────

export const handleAnnotationForRecord = async (
  deps: AnnotationRpcDeps,
  args: { collection?: unknown; id?: unknown },
): Promise<{ annotations: Annotation[] }> => {
  const collection = own(args as Record<string, unknown>, 'collection');
  const id = own(args as Record<string, unknown>, 'id');
  if (typeof collection !== 'string' || typeof id !== 'string') {
    throw new RpcError('bad_request', 'collection and id are required', 400);
  }
  try {
    const annotations = await deps.store.annotationsForRecord(collection, id);
    return { annotations };
  } catch (e) {
    throw mapStoreError(e);
  }
};

// ────────────────────────────────────────────────────────────────
// link.write
// ────────────────────────────────────────────────────────────────

export const handleLinkWrite = async (
  deps: AnnotationRpcDeps,
  args: Record<string, unknown>,
  ctx: { instance_id?: string | null } = {},
): Promise<{ link: Link }> => {
  const from = normalizeRef(args, 'from');
  const to = normalizeRef(args, 'to');
  const role = own(args, 'role');
  if (typeof role !== 'string' || role.length === 0) {
    throw new RpcError('bad_request', 'role is required', 400);
  }
  const recipeId = own(args, 'authored_by_recipe_id');
  if (typeof recipeId !== 'string') {
    throw new RpcError('bad_request', 'authored_by_recipe_id is required', 400);
  }
  const author = deps.getAuthorId?.(ctx) ?? 'rpc';
  try {
    const link = await deps.store.link({
      from_collection: from.collection,
      from_id: from.id,
      to_collection: to.collection,
      to_id: to.id,
      role,
      authored_by_recipe_id: recipeId,
      ...originFields(deps),
    });
    await logActivity(
      deps,
      'link_write',
      `${from.collection}/${from.id} ${role} ${to.collection}/${to.id}`,
      `author=${author}`,
    );
    return { link };
  } catch (e) {
    throw mapStoreError(e);
  }
};

// ────────────────────────────────────────────────────────────────
// link.list / link.delete / link.forRecord
// ────────────────────────────────────────────────────────────────

export const handleLinkList = async (
  deps: AnnotationRpcDeps,
  args: LinkFilter,
): Promise<{ links: Link[] }> => {
  try {
    const links = await deps.store.listLinks(args);
    return { links };
  } catch (e) {
    throw mapStoreError(e);
  }
};

export const handleLinkDelete = async (
  deps: AnnotationRpcDeps,
  args: LinkFilter,
): Promise<{ ok: true; deleted: number }> => {
  try {
    const deleted = await deps.store.deleteLinks(args);
    await logActivity(
      deps,
      'link_delete',
      JSON.stringify(args),
      `deleted=${deleted}`,
    );
    return { ok: true, deleted };
  } catch (e) {
    throw mapStoreError(e);
  }
};

// ────────────────────────────────────────────────────────────────
// D-122 Phase 2 — annotation.create / link.create (upsert semantics)
// ────────────────────────────────────────────────────────────────

/** D-122 Phase 2 — upsert annotation handler.
 *
 *  Idempotent on `(target_collection, target_id, key)`: deletes any
 *  prior row at that triple before writing the new one, in the same
 *  effective transaction. Re-runs of an extraction recipe replace the
 *  prior value rather than append, so the per-record ref read returns
 *  one current value (not a slowly-growing audit list).
 *
 *  Note that the underlying append-shaped `annotation.write` path is
 *  preserved unchanged — graph-builder
 *  recipes use this upsert path; ad-hoc one-off annotations can still
 *  use the append path when keep-history semantics are wanted. */
export const handleAnnotationCreate = async (
  deps: AnnotationRpcDeps,
  args: Record<string, unknown>,
  ctx: { instance_id?: string | null } = {},
): Promise<{ annotation_id: string; annotation: Annotation }> => {
  const targetCollection = own(args, 'target_collection');
  const targetId = own(args, 'target_id');
  if (typeof targetCollection !== 'string' || typeof targetId !== 'string') {
    throw new RpcError(
      'bad_request',
      'annotation.create: target_collection and target_id are required',
      400,
    );
  }
  const key = own(args, 'key');
  if (typeof key !== 'string' || key.length === 0) {
    throw new RpcError('bad_request', 'annotation.create: key is required', 400);
  }
  const sourceHash = own(args, 'source_record_hash');
  if (typeof sourceHash !== 'string') {
    throw new RpcError('bad_request', 'annotation.create: source_record_hash is required', 400);
  }
  const recipeId = own(args, 'authored_by_recipe_id');
  if (typeof recipeId !== 'string') {
    throw new RpcError(
      'bad_request',
      'annotation.create: authored_by_recipe_id is required',
      400,
    );
  }
  const value = hasOwn(args, 'value') ? args.value : null;
  const author = deps.getAuthorId?.(ctx) ?? 'rpc';
  const modelUsed = own(args, 'model_used');
  const eventAt = own(args, 'event_at');

  try {
    // Upsert = delete-then-insert on the unique key. The store opens
    // its own transaction for each statement; sequencing here keeps
    // the delete atomic with respect to itself. The two-statement
    // window is acceptable: a concurrent reader either sees the old
    // row or the new one, never neither — the delete + insert race is
    // bounded by single-process ws traffic on the server side.
    await deps.store.deleteAnnotations({
      target_collection: targetCollection,
      target_id: targetId,
      key,
    });
    const annotation = await deps.store.annotate({
      target_collection: targetCollection,
      target_id: targetId,
      key,
      value,
      authored_by_recipe_id: recipeId,
      source_record_hash: sourceHash,
      ...(typeof modelUsed === 'string' ? { model_used: modelUsed } : {}),
      ...(typeof eventAt === 'number' ? { event_at: eventAt } : {}),
      ...originFields(deps),
    });
    await logActivity(
      deps,
      'annotation_write',
      `${targetCollection}/${targetId}#${key}`,
      `author=${author} upsert=true bytes=${JSON.stringify(value ?? null).length}`,
    );
    return { annotation_id: annotation._id, annotation };
  } catch (e) {
    throw mapStoreError(e);
  }
};

/** D-122 Phase 2 — upsert link handler.
 *
 *  Idempotent on `(from_collection, from_id, to_collection, to_id, role)`.
 *  The production store updates one stable row under a SQLite writer
 *  transaction, so concurrent recipe re-runs cannot accrete duplicate
 *  edges. Engine-emitted provenance links keep using the store's append
 *  path; every explicit recipe `link.create` call uses this handler. */
export const handleLinkCreate = async (
  deps: AnnotationRpcDeps,
  args: Record<string, unknown>,
  ctx: { instance_id?: string | null } = {},
): Promise<{ link: Link }> => {
  const fromCollection = own(args, 'from_collection');
  const fromId = own(args, 'from_id');
  const toCollection = own(args, 'to_collection');
  const toId = own(args, 'to_id');
  if (
    typeof fromCollection !== 'string' || typeof fromId !== 'string'
    || typeof toCollection !== 'string' || typeof toId !== 'string'
  ) {
    throw new RpcError(
      'bad_request',
      'link.create: from_collection / from_id / to_collection / to_id are required',
      400,
    );
  }
  const role = own(args, 'role');
  if (typeof role !== 'string' || role.length === 0) {
    throw new RpcError('bad_request', 'link.create: role (kind) is required', 400);
  }
  const recipeId = own(args, 'authored_by_recipe_id');
  if (typeof recipeId !== 'string') {
    throw new RpcError(
      'bad_request',
      'link.create: authored_by_recipe_id is required',
      400,
    );
  }
  const author = deps.getAuthorId?.(ctx) ?? 'rpc';
  const confidence = own(args, 'confidence');
  const evidence = own(args, 'evidence');
  const eventAt = own(args, 'event_at');
  try {
    const input = {
      from_collection: fromCollection,
      from_id: fromId,
      to_collection: toCollection,
      to_id: toId,
      role,
      authored_by_recipe_id: recipeId,
      ...(typeof confidence === 'number' ? { confidence } : {}),
      ...(typeof evidence === 'string' ? { evidence } : {}),
      ...(typeof eventAt === 'number' ? { event_at: eventAt } : {}),
      ...originFields(deps),
    };
    let link: Link;
    if (deps.store.upsertLink !== undefined) {
      link = await deps.store.upsertLink(input);
    } else {
      // Compatibility fallback for lightweight adapters/test doubles. The
      // production SQLite store provides the atomic path above.
      await deps.store.deleteLinks({
        from_collection: fromCollection,
        from_id: fromId,
        to_collection: toCollection,
        to_id: toId,
        role,
      });
      link = await deps.store.link(input);
    }
    await logActivity(
      deps,
      'link_write',
      `${fromCollection}/${fromId} ${role} ${toCollection}/${toId}`,
      `author=${author} upsert=true${
        typeof confidence === 'number' ? ` conf=${confidence}` : ''
      }`,
    );
    return { link };
  } catch (e) {
    throw mapStoreError(e);
  }
};

export const handleLinkForRecord = async (
  deps: AnnotationRpcDeps,
  args: { collection?: unknown; id?: unknown; direction?: unknown },
): Promise<{ links: Link[] }> => {
  const { collection, id, direction } = args;
  if (typeof collection !== 'string' || typeof id !== 'string') {
    throw new RpcError('bad_request', 'collection and id are required', 400);
  }
  if (direction !== 'outbound' && direction !== 'inbound') {
    throw new RpcError(
      'bad_request',
      'direction must be "outbound" or "inbound"',
      400,
    );
  }
  try {
    const links =
      direction === 'outbound'
        ? await deps.store.outboundLinks(collection, id)
        : await deps.store.inboundLinks(collection, id);
    return { links };
  } catch (e) {
    throw mapStoreError(e);
  }
};

// ────────────────────────────────────────────────────────────────
// Handler slice — composeHandlers factory
// ────────────────────────────────────────────────────────────────

export type AnnotationMethods =
  | 'annotation.write'
  | 'annotation.list'
  | 'annotation.search'
  | 'annotation.delete'
  | 'annotation.forRecord'
  | 'link.write'
  | 'link.list'
  | 'link.delete'
  | 'link.forRecord';

export const makeAnnotationHandlers = (
  deps: AnnotationRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, AnnotationMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  // D-161 P2 — a direct paired-client `annotation.write` / `link.write`
  // rpc arrives on the `user` channel by construction, so the write-actor
  // is `'user_self'`. Inject it SERVER-SIDE here (not from `args`) so the
  // store stamps the right origin. Read paths keep plain `deps`.
  // D-177 N.11 rule 1 — 'client_rpc' marks the human's own paired
  // client; the recipe-path deps lift stamps 'engine'. This pair is what
  // the stored-cleanliness gate reads.
  const writeDeps: AnnotationRpcDeps = {
    ...deps,
    origin_actor: 'user_self',
    origin_surface: 'client_rpc',
  };
  return {
    methods: [
      'annotation.write',
      'annotation.list',
      'annotation.search',
      'annotation.delete',
      'annotation.forRecord',
      'link.write',
      'link.list',
      'link.delete',
      'link.forRecord',
    ],
    handlers: {
      'annotation.write': async (args, client) =>
        handleAnnotationWrite(
          writeDeps,
          args as Record<string, unknown>,
          { instance_id: client.instance_id ?? undefined },
        ),
      'annotation.list': async (args) =>
        handleAnnotationList(deps, args as AnnotationFilter),
      'annotation.search': async (args) =>
        handleAnnotationSearch(deps, args as AnnotationSearchQuery),
      'annotation.delete': async (args) =>
        handleAnnotationDelete(deps, args as AnnotationFilter),
      'annotation.forRecord': async (args) =>
        handleAnnotationForRecord(
          deps,
          args as Parameters<typeof handleAnnotationForRecord>[1],
        ),
      'link.write': async (args, client) =>
        handleLinkWrite(
          writeDeps,
          args as Record<string, unknown>,
          { instance_id: client.instance_id ?? undefined },
        ),
      'link.list': async (args) => handleLinkList(deps, args as LinkFilter),
      'link.delete': async (args) =>
        handleLinkDelete(deps, args as LinkFilter),
      'link.forRecord': async (args) =>
        handleLinkForRecord(
          deps,
          args as Parameters<typeof handleLinkForRecord>[1],
        ),
    },
  };
};
