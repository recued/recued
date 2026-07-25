/** rpc handlers for the `shared.*` method family.
 *
 *  Seven methods — shared.write / compare-and-set / read / list / search /
 *  delete / delete-prefix.
 *  Routing lives here: `shared.*` keys land in the cache tier (via the
 *  paired extension's own cache or a future server-side shared cache);
 *  `data.shared.*` keys go to the durable SharedStore (SQLite +
 *  content-addressed blobs).
 *  Phase A ships the durable side only — the cache tier is covered by
 *  the existing `cache.*` rpc (the ext kernel ingredient routes there
 *  directly when the key prefix starts with `shared.`). */

import { RpcError } from '@recued/contracts';
import type {
  HandlerSlice,
  ServerRpcRegistry,
  SharedCompareAndSetResult,
  SharedListEntry,
  SharedReadResult,
  SharedSearchMatch,
} from '@recued/contracts';
import { estimateSize, type StorageGate } from '@recued/storage-gate';
import type { AuditLogStore } from '@recued/storage';
import type { WsClient } from './ws-server.js';
import {
  SharedCompareAndSetConflictError,
  SharedCompareAndSetRequiredError,
  SharedCompareAndSetValidationError,
  SharedCompareAndSetValueTooLargeError,
  SharedKeyInvalidError,
  SharedValueSerializationError,
  SubkeyWriteError,
  ValueTooLargeError,
  type SharedStore,
} from './storage/shared-store.js';

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const own = (value: Record<string, unknown>, key: string): unknown =>
  hasOwn(value, key) ? value[key] : undefined;

export interface SharedRpcDeps {
  store: SharedStore;
  /** Author of writes arriving via this rpc. The runtime resolves this
   *  per-call to the paired ext's author id (user or publisher,
   *  depending on where the write originated); absent deps use a
   *  synthetic `"rpc"` tag so the audit trail records something. */
  getAuthorId?: (ctx: { instance_id?: string | null }) => string | null;
  /** Optional audit log — when wired, successful writes + deletes emit
   *  `shared_write` / `shared_delete` / `shared_delete_prefix` activity
   *  entries. Failures never emit (the error travels to the caller). */
  auditLog?: AuditLogStore;
  /** Phase B gate — admission check for `shared.write`. Durable
   *  `data.shared.*` writes (including compare-and-set) are always user-class
   *  (never reserve);
   *  rejections at `writes_blocked` surface as `RpcError('storage_pressure', …)`
   *  so the caller can backoff. Absent → enforcement off (legacy). */
  gate?: StorageGate;
}

const logActivity = async (
  deps: SharedRpcDeps,
  action: 'shared_write' | 'shared_delete' | 'shared_delete_prefix',
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
    // audit is best-effort; a failure here must never bubble to the
    // caller and cancel the actual store write.
  }
};

const DATA_SHARED_PREFIX = 'data.shared.';
const CACHE_SHARED_PREFIX = 'shared.';

/** Extract the durable-store key from a user-facing key. For
 *  `data.shared.deal.123` that's `deal.123`; for `shared.foo` it's the
 *  whole key (the cache tier owns these, so the durable store never
 *  sees them). */
const requireDurableKey = (userKey: string): string => {
  if (!userKey.startsWith(DATA_SHARED_PREFIX)) {
    throw new RpcError(
      'bad_request',
      `shared_key_invalid: expected 'data.shared.' prefix, got '${userKey}'`,
      400,
    );
  }
  return userKey.slice(DATA_SHARED_PREFIX.length);
};

/** Same shape for prefix arguments on list / search / delete-prefix. */
const requireDurablePrefix = (userPrefix: string): string => {
  if (!userPrefix.startsWith(DATA_SHARED_PREFIX)) {
    throw new RpcError(
      'bad_request',
      `shared_key_invalid: expected 'data.shared.' prefix, got '${userPrefix}'`,
      400,
    );
  }
  return userPrefix.slice(DATA_SHARED_PREFIX.length);
};

/** Route a key prefix: `shared.*` → cache tier (not handled here);
 *  `data.shared.*` → durable. */
export const keyRoutesToDurable = (key: string): boolean =>
  key.startsWith(DATA_SHARED_PREFIX);

export const keyRoutesToCache = (key: string): boolean =>
  key.startsWith(CACHE_SHARED_PREFIX) && !key.startsWith(DATA_SHARED_PREFIX);

const mapStoreError = (e: unknown): RpcError => {
  if (e instanceof SharedKeyInvalidError || e instanceof SubkeyWriteError) {
    return new RpcError('bad_request', e.message, 400);
  }
  if (
    e instanceof SharedCompareAndSetValidationError
    || e instanceof SharedValueSerializationError
  ) {
    return new RpcError('bad_request', e.message, 400);
  }
  if (e instanceof SharedCompareAndSetConflictError) {
    return new RpcError('conflict', e.message, 409, 'shared.compare-and-set', {
      key: `${DATA_SHARED_PREFIX}${e.key}`,
      expected_revision: e.expectedRevision,
      actual_revision: e.actualRevision,
      found: e.found,
    });
  }
  if (e instanceof SharedCompareAndSetRequiredError) {
    return new RpcError('conflict', e.message, 409, `shared.${e.operation}`, {
      key: `${DATA_SHARED_PREFIX}${e.key}`,
      operation: e.operation,
    });
  }
  if (e instanceof ValueTooLargeError || e instanceof SharedCompareAndSetValueTooLargeError) {
    return new RpcError('payload_too_large', e.message, 413);
  }
  if (e instanceof RpcError) return e;
  // Don't echo raw SQLite / internal error text (table + column names, FTS5
  // parser detail) to the caller — log it server-side, return a generic 500.
  console.error('shared-handler: unexpected store error', e);
  return new RpcError('internal_error', 'internal error', 500);
};

const assertWriteAdmitted = (
  deps: SharedRpcDeps,
  value: unknown,
): void => {
  if (!deps.gate) return;
  const projected = estimateSize(value);
  const check = deps.gate.canWrite(projected);
  if (check.ok) return;
  if (deps.auditLog) {
    void deps.auditLog.logActivity({
      activity_id: '',
      timestamp: Date.now(),
      action: 'quota_exceeded',
      target: 'shared_store',
      detail: check.reason ?? 'storage_pressure',
    }).catch(() => { /* best-effort */ });
  }
  throw new RpcError(
    check.reason === 'writes_blocked' ? 'storage_pressure' : check.reason ?? 'storage_pressure',
    `shared_store write rejected: ${check.reason}`,
    check.reason === 'storage_pressure' ? 429 : 507,
  );
};

// ────────────────────────────────────────────────────────────────
// shared.write
// ────────────────────────────────────────────────────────────────

export const handleSharedWrite = async (
  deps: SharedRpcDeps,
  args: { key?: unknown; value?: unknown; ttl?: unknown },
  ctx: { instance_id?: string | null } = {},
): Promise<{ ok: true; key: string; bytes_written: number }> => {
  const key = own(args as Record<string, unknown>, 'key');
  if (typeof key !== 'string') {
    throw new RpcError('bad_request', 'key is required', 400);
  }
  if (!keyRoutesToDurable(key)) {
    throw new RpcError(
      'bad_request',
      `shared_key_invalid: shared.write rpc only accepts 'data.shared.*' keys (cache-tier writes route through cache.put)`,
      400,
    );
  }
  const value = hasOwn(args as Record<string, unknown>, 'value') ? args.value : undefined;
  if (own(args as Record<string, unknown>, 'ttl') !== undefined) {
    // Durable writes don't honor TTL; fail open with a warning is fine,
    // but fail closed is clearer. Callers shouldn't send ttl here.
    throw new RpcError(
      'bad_request',
      `ttl is not honored for data.shared.* writes`,
      400,
    );
  }
  const durableKey = requireDurableKey(key);
  const author = deps.getAuthorId?.(ctx) ?? 'rpc';

  // `estimateSize` matches what the store persists (canonical JSON), keeping
  // the gate's accounting aligned with `size_bytes`.
  assertWriteAdmitted(deps, value);

  try {
    const res = await deps.store.write(durableKey, value, { author_id: author });
    await logActivity(deps, 'shared_write', key, `bytes=${res.bytes}`);
    return { ok: true, key, bytes_written: res.bytes };
  } catch (e) {
    throw mapStoreError(e);
  }
};

// ────────────────────────────────────────────────────────────────
// shared.compare-and-set
// ────────────────────────────────────────────────────────────────

export const handleSharedCompareAndSet = async (
  deps: SharedRpcDeps,
  args: { key?: unknown; expected_revision?: unknown; value?: unknown },
  ctx: { instance_id?: string | null } = {},
): Promise<SharedCompareAndSetResult> => {
  const raw = args as Record<string, unknown>;
  const key = own(raw, 'key');
  if (typeof key !== 'string') {
    throw new RpcError('bad_request', 'key is required', 400);
  }
  if (!keyRoutesToDurable(key)) {
    throw new RpcError(
      'bad_request',
      `shared.compare-and-set rpc only accepts 'data.shared.*' keys`,
      400,
    );
  }
  const expectedRevision = own(raw, 'expected_revision');
  if (
    expectedRevision !== null
    && (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 0)
  ) {
    throw new RpcError(
      'bad_request',
      'expected_revision must be null or a non-negative safe integer',
      400,
    );
  }
  if (!hasOwn(raw, 'value')) {
    throw new RpcError('bad_request', 'value is required', 400);
  }
  const value = args.value;
  assertWriteAdmitted(deps, value);

  const durableKey = requireDurableKey(key);
  const author = deps.getAuthorId?.(ctx) ?? 'rpc';
  try {
    const result = await deps.store.compareAndSet(
      durableKey,
      expectedRevision as number | null,
      value,
      { author_id: author },
    );
    await logActivity(
      deps,
      'shared_write',
      key,
      `cas_revision=${result.revision};bytes=${result.bytes}`,
    );
    return {
      ok: true,
      key,
      revision: result.revision,
      created: result.created,
      bytes_written: result.bytes,
    };
  } catch (e) {
    throw mapStoreError(e);
  }
};

// ────────────────────────────────────────────────────────────────
// shared.read
// ────────────────────────────────────────────────────────────────

export const handleSharedRead = async (
  deps: SharedRpcDeps,
  args: { key?: unknown },
): Promise<SharedReadResult> => {
  const key = own(args as Record<string, unknown>, 'key');
  if (typeof key !== 'string') {
    throw new RpcError('bad_request', 'key is required', 400);
  }
  if (!keyRoutesToDurable(key)) {
    throw new RpcError(
      'bad_request',
      `shared.read rpc only accepts 'data.shared.*' keys`,
      400,
    );
  }
  const durableKey = requireDurableKey(key);
  try {
    const record = await deps.store.read(durableKey);
    if (!record) return { found: false, key };
    return {
      found: true,
      key,
      value: record.value,
      cas_revision: record.cas_revision,
    };
  } catch (e) {
    throw mapStoreError(e);
  }
};

// ────────────────────────────────────────────────────────────────
// shared.list
// ────────────────────────────────────────────────────────────────

export const handleSharedList = async (
  deps: SharedRpcDeps,
  args: { prefix?: unknown },
): Promise<{ entries: SharedListEntry[] }> => {
  const prefix = args.prefix;
  if (typeof prefix !== 'string') {
    throw new RpcError('bad_request', 'prefix is required', 400);
  }
  if (!keyRoutesToDurable(prefix)) {
    throw new RpcError(
      'bad_request',
      `shared.list rpc only accepts 'data.shared.*' prefixes`,
      400,
    );
  }
  const durablePrefix = requireDurablePrefix(prefix);
  try {
    const rows = await deps.store.list(durablePrefix);
    return {
      entries: rows.map((r) => ({ key: `${DATA_SHARED_PREFIX}${r.key}`, value: r.value })),
    };
  } catch (e) {
    throw mapStoreError(e);
  }
};

// ────────────────────────────────────────────────────────────────
// shared.search
// ────────────────────────────────────────────────────────────────

export const handleSharedSearch = async (
  deps: SharedRpcDeps,
  args: { scope?: unknown; query?: unknown },
): Promise<{ matches: SharedSearchMatch[] }> => {
  const scope = args.scope;
  const query = args.query;
  if (typeof query !== 'string' || query.length === 0) {
    throw new RpcError('bad_request', 'query is required', 400);
  }
  if (typeof scope !== 'string' || !keyRoutesToDurable(scope.endsWith('.*') ? scope.slice(0, -2) : scope)) {
    throw new RpcError(
      'bad_request',
      `shared.search rpc only accepts 'data.shared.*' scopes`,
      400,
    );
  }
  const durableScope = scope.endsWith('.*')
    ? `${requireDurablePrefix(scope.slice(0, -2))}.*`
    : requireDurablePrefix(scope);
  try {
    const results = await deps.store.search(durableScope, query);
    return {
      matches: results.map((r) => ({
        key: `${DATA_SHARED_PREFIX}${r.key}`,
        value: r.value,
        rank: r.rank,
      })),
    };
  } catch (e) {
    throw mapStoreError(e);
  }
};

// ────────────────────────────────────────────────────────────────
// shared.delete
// ────────────────────────────────────────────────────────────────

export const handleSharedDelete = async (
  deps: SharedRpcDeps,
  args: { key?: unknown },
): Promise<{ ok: true; key: string }> => {
  const key = args.key;
  if (typeof key !== 'string') {
    throw new RpcError('bad_request', 'key is required', 400);
  }
  if (!keyRoutesToDurable(key)) {
    throw new RpcError(
      'bad_request',
      `shared.delete rpc only accepts 'data.shared.*' keys`,
      400,
    );
  }
  const durableKey = requireDurableKey(key);
  try {
    await deps.store.delete(durableKey);
    await logActivity(deps, 'shared_delete', key);
    return { ok: true, key };
  } catch (e) {
    throw mapStoreError(e);
  }
};

// ────────────────────────────────────────────────────────────────
// shared.delete-prefix
// ────────────────────────────────────────────────────────────────

export const handleSharedDeletePrefix = async (
  deps: SharedRpcDeps,
  args: { prefix?: unknown },
): Promise<{ ok: true; prefix: string; deleted: number }> => {
  const prefix = args.prefix;
  if (typeof prefix !== 'string') {
    throw new RpcError('bad_request', 'prefix is required', 400);
  }
  if (!keyRoutesToDurable(prefix)) {
    throw new RpcError(
      'bad_request',
      `shared.delete-prefix rpc only accepts 'data.shared.*' prefixes`,
      400,
    );
  }
  const durablePrefix = requireDurablePrefix(prefix);
  try {
    const deleted = await deps.store.deleteByPrefix(durablePrefix);
    await logActivity(deps, 'shared_delete_prefix', prefix, `deleted=${deleted}`);
    return { ok: true, prefix, deleted };
  } catch (e) {
    throw mapStoreError(e);
  }
};

// ────────────────────────────────────────────────────────────────
// Handler slice — composeHandlers factory
// ────────────────────────────────────────────────────────────────

export type SharedMethods =
  | 'shared.write'
  | 'shared.compare-and-set'
  | 'shared.read'
  | 'shared.list'
  | 'shared.search'
  | 'shared.delete'
  | 'shared.delete-prefix';

export const makeSharedHandlers = (
  deps: SharedRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, SharedMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: [
      'shared.write',
      'shared.compare-and-set',
      'shared.read',
      'shared.list',
      'shared.search',
      'shared.delete',
      'shared.delete-prefix',
    ],
    handlers: {
      'shared.write': async (args, client) =>
        handleSharedWrite(
          deps,
          args as Parameters<typeof handleSharedWrite>[1],
          { instance_id: client.instance_id ?? undefined },
        ),
      'shared.compare-and-set': async (args, client) =>
        handleSharedCompareAndSet(
          deps,
          args as Parameters<typeof handleSharedCompareAndSet>[1],
          { instance_id: client.instance_id ?? undefined },
        ),
      'shared.read': async (args) =>
        handleSharedRead(deps, args as Parameters<typeof handleSharedRead>[1]),
      'shared.list': async (args) =>
        handleSharedList(deps, args as Parameters<typeof handleSharedList>[1]),
      'shared.search': async (args) =>
        handleSharedSearch(deps, args as Parameters<typeof handleSharedSearch>[1]),
      'shared.delete': async (args) =>
        handleSharedDelete(deps, args as Parameters<typeof handleSharedDelete>[1]),
      'shared.delete-prefix': async (args) =>
        handleSharedDeletePrefix(deps, args as Parameters<typeof handleSharedDeletePrefix>[1]),
    },
  };
};
