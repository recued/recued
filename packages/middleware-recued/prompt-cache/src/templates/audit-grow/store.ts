/** D-164 P4h-4b — audit-grow snapshot on-disk store.
 *
 *  `createFileAuditGrowStore({path})` returns an `AuditGrowStore`
 *  whose state is the latest persisted `AuditGrowSnapshot`, with an
 *  in-memory cache layered on top so callers don't pay an I/O round
 *  trip per `current()` call. The store is the persistence half of
 *  the audit-grow substrate; `./index.ts`'s
 *  `createStoreBackedAuditGrowFactory` adapts it to a live
 *  `TemplatePool` whose `list()` reflects the latest persisted
 *  snapshot without library / gate rebuilds.
 *
 *  Atomic writes. `put` serialises the snapshot to JSON, writes to
 *  `<path>.tmp.<random>` (collision-resistant suffix so two
 *  concurrent puts don't trample each other), then renames to the
 *  final path. The rename step is atomic on every Unix filesystem
 *  the server runs on, so a crash mid-write leaves the previous
 *  snapshot intact rather than a half-written corrupted file.
 *  Mirrors the bundle store's `persistAtomically` posture.
 *
 *  Subscriber fan-out. `put` fires every subscriber after the
 *  in-memory cache updates. A subscriber that throws is contained in
 *  its own try/catch so a buggy listener can't tear down the store
 *  or block sibling subscribers — same defensive posture as the
 *  bundle poller's `safeInvoke`. The store guarantees subscribers
 *  observe successful puts in registration order; subscribers are
 *  NOT notified on failed puts (the cache is unchanged + state would
 *  mislead them).
 *
 *  Load semantics. On construction `loadFromDisk` reads the file;
 *  missing file returns `null` (`current()` then returns `null`,
 *  signalling "no promotions yet"). Read errors (permission denied,
 *  corrupt JSON, schema mismatch) throw `AuditGrowStoreError` with
 *  a structured `reason` discriminator so the boot path can branch
 *  on cause.
 *
 *  **Server-only.** Uses `node:fs/promises` + `node:path` + `node:crypto`
 *  for atomic-rename + temp-name generation. The prompt-cache package
 *  is server-side per design (D-148 P12 — "no client-side execution").
 *
 *  Why a distinct `AuditGrowStoreError` instead of reusing
 *  `BundleFetchError`: the bundle error class is bundle-scoped (its
 *  `message` prefix says `bundle fetch ...` + carries reasons like
 *  `http_error` / `cache_empty` that don't apply to audit-grow's
 *  local-only path). A separate class keeps operator messages
 *  precise + lets callers branch the two layers without aliasing the
 *  reason union.
 *
 *  Out of scope (deferred):
 *    - **SQLite persistence.** Per-snapshot file persistence is
 *      sufficient for the per-pair audit-grow size (small N of
 *      user-promoted templates per pair). A SQLite migration is
 *      easy later if growth + per-entry mutation patterns argue
 *      for it.
 *    - **Per-entry content-addressed cache.** The current store
 *      persists the whole snapshot as one file (analogous to the
 *      bundle store's one-file design).
 *    - **File locking.** One writer per pair per host (the boot
 *      wiring); last-writer-wins is acceptable.
 *
 *  See: D-164
 *  § 1 templates/audit-grow / O-6 (user-promoted only). */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { AuditGrowEntryInput } from './validate.js';

/** Top-level snapshot shape the audit-grow store persists. `version`
 *  is opaque to the store (forward-compat for an eventual schema
 *  migration); `entries` is the user-promoted candidate list the
 *  pool factory consumes. Mirrors `BundleManifest` minus the bundle-
 *  specific framing — kept symmetric so a future `templates/snapshot.ts`
 *  hoist can collapse both shapes into one. */
export interface AuditGrowSnapshot {
  readonly version: string;
  readonly entries: ReadonlyArray<AuditGrowEntryInput>;
}

/** Discriminator for `AuditGrowStoreError.reason`.
 *
 *  - `disk_error` — local filesystem operation failed (read, write,
 *    rename, mkdir).
 *  - `parse_error` — file body wasn't valid JSON.
 *  - `schema_invalid` — JSON parsed but didn't match the snapshot
 *    shape contract (shallow check; per-entry validation is the
 *    pool's job). */
export type AuditGrowStoreErrorReason =
  | 'disk_error'
  | 'parse_error'
  | 'schema_invalid';

/** Thrown by any store path that can't read / parse / persist a
 *  valid snapshot. Carries the structured reason + a free-form
 *  detail (caller-supplied values JSON.stringify'd so newlines /
 *  control chars can't forge extra log lines, matching the bundle
 *  fetch error's posture). */
export class AuditGrowStoreError extends Error {
  readonly reason: AuditGrowStoreErrorReason;
  readonly detail: string;

  constructor(opts: {
    readonly reason: AuditGrowStoreErrorReason;
    readonly detail: string;
  }) {
    super(`audit-grow store ${opts.reason}: ${opts.detail}`);
    this.name = 'AuditGrowStoreError';
    this.reason = opts.reason;
    this.detail = opts.detail;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isString = (value: unknown): value is string => typeof value === 'string';

/** Parse a raw JSON value into a typed `AuditGrowSnapshot`. Pure /
 *  synchronous. Throws `AuditGrowStoreError` with
 *  `reason: 'schema_invalid'` on any shape mismatch; the error's
 *  `detail` names the offending field so boot logs can pinpoint the
 *  bad row.
 *
 *  Shallow validation only: top-level `{version, entries}` shape,
 *  per-entry `{template: object, locale: string, step_kinds: array}`
 *  shape. The deep per-template validation (kind / action_class /
 *  hash / forbidden paths) is the pool's job
 *  (`validateAuditGrowEntry`). Mirrors `parseBundleManifest`'s
 *  posture: this parser single-throws on the first manifest-shape
 *  violation; callers only reach pool aggregate validation after
 *  every entry clears the shallow boundary. */
export const parseAuditGrowSnapshot = (raw: unknown): AuditGrowSnapshot => {
  if (!isObject(raw)) {
    throw new AuditGrowStoreError({
      reason: 'schema_invalid',
      detail: `snapshot root must be an object, got ${typeof raw}`,
    });
  }
  if (!isString(raw['version']) || raw['version'].length === 0) {
    throw new AuditGrowStoreError({
      reason: 'schema_invalid',
      detail: `snapshot.version must be a non-empty string, got ${JSON.stringify(raw['version'])}`,
    });
  }
  const entriesRaw = raw['entries'];
  if (!Array.isArray(entriesRaw)) {
    throw new AuditGrowStoreError({
      reason: 'schema_invalid',
      detail: `snapshot.entries must be an array, got ${typeof entriesRaw}`,
    });
  }
  const entries: AuditGrowEntryInput[] = [];
  entriesRaw.forEach((entry, index) => {
    if (!isObject(entry)) {
      throw new AuditGrowStoreError({
        reason: 'schema_invalid',
        detail: `snapshot.entries[${index}] must be an object, got ${typeof entry}`,
      });
    }
    // Mirror parseBundleManifest's defensive read: the parser
    // contract is "throws only AuditGrowStoreError"; a throwing
    // accessor on a hand-built object would otherwise leak out as
    // a different error class.
    let templateRaw: unknown;
    let localeRaw: unknown;
    let stepKindsRaw: unknown;
    try {
      templateRaw = entry['template'];
      localeRaw = entry['locale'];
      stepKindsRaw = entry['step_kinds'];
    } catch (err) {
      throw new AuditGrowStoreError({
        reason: 'schema_invalid',
        detail: `snapshot.entries[${index}]: property access threw: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    if (!isObject(templateRaw)) {
      throw new AuditGrowStoreError({
        reason: 'schema_invalid',
        detail: `snapshot.entries[${index}].template must be an object, got ${typeof templateRaw}`,
      });
    }
    if (!isString(localeRaw) || localeRaw.length === 0) {
      throw new AuditGrowStoreError({
        reason: 'schema_invalid',
        detail: `snapshot.entries[${index}].locale must be a non-empty string, got ${JSON.stringify(localeRaw)}`,
      });
    }
    if (!Array.isArray(stepKindsRaw)) {
      throw new AuditGrowStoreError({
        reason: 'schema_invalid',
        detail: `snapshot.entries[${index}].step_kinds must be an array, got ${typeof stepKindsRaw}`,
      });
    }
    const stepKinds: string[] = [];
    stepKindsRaw.forEach((kind, kIndex) => {
      if (!isString(kind)) {
        throw new AuditGrowStoreError({
          reason: 'schema_invalid',
          detail: `snapshot.entries[${index}].step_kinds[${kIndex}] must be a string, got ${typeof kind}`,
        });
      }
      stepKinds.push(kind);
    });
    entries.push({
      // `templateRaw` is shape-validated as an object only; the deep
      // kind / action_class / hash checks belong to the pool's
      // validator. The `unknown` hop is required because the strict
      // structural-types check rejects the direct cast from
      // `Record<string, unknown>` — same trick as the bundle parser.
      template: templateRaw as unknown as AuditGrowEntryInput['template'],
      locale: localeRaw,
      step_kinds: stepKinds,
    });
  });
  return {
    version: raw['version'],
    entries,
  };
};

/** Listener notified after every successful `put`. Receives the
 *  freshly-persisted snapshot. Listeners run synchronously in
 *  registration order; throws are contained but never re-raised
 *  (the contract is fire-and-forget). */
export type AuditGrowStoreListener = (snapshot: AuditGrowSnapshot) => void;

/** Pure persistence primitive. Exposes the current cached snapshot,
 *  a `put` to replace it, and a `subscribe` for live consumers
 *  (e.g., the store-backed pool factory). */
export interface AuditGrowStore {
  /** The latest snapshot stored, or `null` when nothing's cached
   *  (initial empty state — cold boot before any user promotion).
   *  Synchronous — the in-memory cache makes this safe to call per
   *  `match()` iteration without I/O. */
  current(): AuditGrowSnapshot | null;
  /** Replace the cached snapshot and persist atomically to disk.
   *  Throws `AuditGrowStoreError` on filesystem failures; the
   *  in-memory cache + subscriber fan-out only run after the write
   *  succeeds, so a failed `put` leaves `current()` unchanged and
   *  listeners undisturbed. */
  put(snapshot: AuditGrowSnapshot): Promise<void>;
  /** Register `listener` to be invoked synchronously after every
   *  successful `put`. Returns an idempotent unsubscribe; subsequent
   *  calls are no-ops. Listeners that throw are isolated — the
   *  throw is swallowed and sibling listeners still fire. */
  subscribe(listener: AuditGrowStoreListener): () => void;
}

export interface CreateFileAuditGrowStoreOptions {
  /** Absolute filesystem path the snapshot is persisted under.
   *  The parent directory is `mkdir`'d on construction (recursive)
   *  so callers don't need to pre-create it. Per-pair scoping is the
   *  caller's concern — pass `<warehouse_root>/<pair_id>/audit-grow/
   *  snapshot.json` (or similar) at boot wiring. */
  readonly path: string;
}

/** Generate a collision-resistant temp suffix so two concurrent
 *  `put`s on the same path don't trample each other's temp files.
 *  Hex-encoded so the suffix is filesystem-safe everywhere. Mirrors
 *  the bundle store's helper. */
const tempSuffix = (): string => randomBytes(8).toString('hex');

/** Read + parse the snapshot from disk. Returns `null` when the file
 *  is missing (the cold-start signal); throws `AuditGrowStoreError`
 *  for any other failure mode. Disk errors get `disk_error`; JSON
 *  parse failures get `parse_error`; schema failures get
 *  `schema_invalid` (re-raised from `parseAuditGrowSnapshot`). */
const loadFromDisk = async (
  path: string,
): Promise<AuditGrowSnapshot | null> => {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new AuditGrowStoreError({
      reason: 'disk_error',
      detail: `read ${JSON.stringify(path)}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new AuditGrowStoreError({
      reason: 'parse_error',
      detail: `snapshot file ${JSON.stringify(path)} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  return parseAuditGrowSnapshot(json);
};

/** Persist a snapshot atomically: write to a temp path, then rename.
 *  The temp lives in the same directory as the final path so the
 *  rename never crosses a filesystem boundary (EXDEV is impossible
 *  by construction). On any failure the temp file is best-effort
 *  unlinked so half-written cruft doesn't accumulate; the rename
 *  never runs and the previous final file (if any) survives.
 *
 *  No fsync — the snapshot caches an idempotently-rederivable
 *  artifact (user-promoted templates whose source-of-truth is the
 *  action history); a crash mid-write loses at most one update
 *  + a stale temp file, and the user can re-promote on the next
 *  session. The same trade-off the bundle store makes; cross-pool
 *  consistency keeps operator expectations uniform. */
const persistAtomically = async (
  path: string,
  snapshot: AuditGrowSnapshot,
): Promise<void> => {
  const tempPath = `${path}.tmp.${tempSuffix()}`;
  const payload = JSON.stringify(snapshot);
  try {
    await writeFile(tempPath, payload, { encoding: 'utf8' });
  } catch (err) {
    // Even a failed write can leave a partial temp file on some
    // filesystems (e.g., out-of-space after the inode was created);
    // unlink it so we don't accumulate stale temps across retries.
    await unlink(tempPath).catch(() => undefined);
    throw new AuditGrowStoreError({
      reason: 'disk_error',
      detail: `write ${JSON.stringify(tempPath)}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  try {
    await rename(tempPath, path);
  } catch (err) {
    // Best-effort cleanup; ignore unlink failures because the temp
    // file may already be gone.
    await unlink(tempPath).catch(() => undefined);
    throw new AuditGrowStoreError({
      reason: 'disk_error',
      detail: `rename ${JSON.stringify(tempPath)} → ${JSON.stringify(path)}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
};

/** Build the FS-backed store. Reads the parent directory's existence
 *  via `mkdir(recursive)`, then loads any existing snapshot into the
 *  in-memory cache. Subsequent `put` writes are atomic + update the
 *  cache on success + fan out to subscribers. */
export const createFileAuditGrowStore = async (
  options: CreateFileAuditGrowStoreOptions,
): Promise<AuditGrowStore> => {
  const { path } = options;
  try {
    await mkdir(dirname(path), { recursive: true });
  } catch (err) {
    // Parent-dir creation can fail for permission / EISDIR / read-only
    // mount reasons; surface as `disk_error` so the construction
    // contract "throws only AuditGrowStoreError" holds. Without this,
    // a raw ErrnoException would leak and operator logs would see a
    // different error class than the rest of the store path.
    throw new AuditGrowStoreError({
      reason: 'disk_error',
      detail: `mkdir ${JSON.stringify(dirname(path))}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  let cached: AuditGrowSnapshot | null = await loadFromDisk(path);
  const listeners = new Set<AuditGrowStoreListener>();

  const fanOut = (snapshot: AuditGrowSnapshot): void => {
    // Snapshot the listener set before iteration so a listener that
    // synchronously unsubscribes itself (or another) during fan-out
    // doesn't skip / re-fire any listener. Set iteration over the
    // live set has surprising semantics under concurrent mutation.
    const snapshotListeners = [...listeners];
    for (const listener of snapshotListeners) {
      try {
        listener(snapshot);
      } catch {
        // Listener failures must not tear down the store or block
        // sibling listeners; the audit-grow gate's pass-through is
        // the runtime safety net for the wider pipeline.
      }
    }
  };

  return {
    current(): AuditGrowSnapshot | null {
      return cached;
    },
    async put(snapshot: AuditGrowSnapshot): Promise<void> {
      await persistAtomically(path, snapshot);
      cached = snapshot;
      fanOut(snapshot);
    },
    subscribe(listener: AuditGrowStoreListener): () => void {
      listeners.add(listener);
      let active = true;
      return (): void => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
      };
    },
  };
};
