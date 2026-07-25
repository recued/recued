/** D-115 Phase 6B — file-watcher backend handler.
 *
 *  Reads the server's `data.file.<slug>` warehouse and fires when
 *  file records whose `modified_at` is at or after the caller's
 *  `since` cursor match the optional path / extension / size
 *  filters. Uses the Phase 6B `CollectionListQuery.modified_since`
 *  extension — file adapters update `modified_at` on every re-sync
 *  while `received_at` only captures the first insert, so
 *  `modified_at` is the correct cursor field for "files that
 *  changed after X".
 *
 *  Filter strategy:
 *    - `path_prefix` ⇒ JS prefix match against `hot_fields.path`.
 *      Case-sensitive; use leading slash matching the adapter's
 *      path convention (fs adapter writes forward-slash POSIX
 *      paths; s3 adapter writes the S3 key).
 *    - `extension` ⇒ JS suffix match against `hot_fields.path`.
 *      Accepts `".md"` or `"md"` — both normalise to the same
 *      comparison.
 *    - `min_size` / `max_size` ⇒ JS bound check against
 *      `hot_fields.size`. Either bound may be absent.
 *
 *  Item shape strips `body_inline` + `blob_hash`: file contents
 *  stay in the warehouse + CAS; the trigger context only sees
 *  metadata (matches the manifest's "metadata-only" contract).
 *
 *  Missing collection ⇒ no-fire envelope. Same rationale as
 *  mail-watcher / calendar-watcher — don't trip the reactive
 *  scheduler's breaker on a restarting adapter. */

import { IngredientError } from '@recued/ingredients';
import type { CollectionRecord } from '@recued/contracts';

import type { Collection } from '../types.js';

const OVERFETCH_FACTOR = 4;
const MAX_FETCH_LIMIT = 500;
const DEFAULT_LIMIT = 50;

export interface FileWatcherArgs {
  slug: string;
  since?: number;
  path_prefix?: string;
  extension?: string;
  min_size?: number;
  max_size?: number;
  limit?: number;
}

export interface FileWatcherItem {
  record_id: string;
  received_at: number;
  modified_at: number;
  source_id: string;
  size_bytes: number;
  hot_fields: Record<string, unknown>;
}

export interface FileWatcherOutput {
  should_run: boolean;
  items: FileWatcherItem[];
  last_seen_at: number;
  [field: string]: unknown;
}

export interface FileWatcherDeps {
  getCollection: (slug: string) => Collection | undefined;
  now?: () => number;
}

const parseArgs = (input: Record<string, unknown>): FileWatcherArgs => {
  const slug = input.slug;
  if (typeof slug !== 'string' || slug === '') {
    throw new IngredientError(
      'TRANSFORM_INVALID_INPUT',
      'file-watcher: `slug` is required',
      { got: slug },
    );
  }
  const out: FileWatcherArgs = { slug };
  if (typeof input.since === 'number' && Number.isFinite(input.since)) {
    out.since = input.since;
  }
  if (typeof input.path_prefix === 'string' && input.path_prefix !== '') {
    out.path_prefix = input.path_prefix;
  }
  if (typeof input.extension === 'string' && input.extension !== '') {
    out.extension = input.extension;
  }
  if (typeof input.min_size === 'number' && Number.isFinite(input.min_size)) {
    if (input.min_size < 0) {
      throw new IngredientError(
        'TRANSFORM_INVALID_INPUT',
        'file-watcher: `min_size` must be non-negative',
        { got: input.min_size },
      );
    }
    out.min_size = input.min_size;
  }
  if (typeof input.max_size === 'number' && Number.isFinite(input.max_size)) {
    if (input.max_size < 0) {
      throw new IngredientError(
        'TRANSFORM_INVALID_INPUT',
        'file-watcher: `max_size` must be non-negative',
        { got: input.max_size },
      );
    }
    out.max_size = input.max_size;
  }
  if (typeof input.limit === 'number' && Number.isFinite(input.limit)) {
    out.limit = input.limit;
  }
  return out;
};

const resolveLimit = (raw: number | undefined): number => {
  const n = raw ?? DEFAULT_LIMIT;
  return Math.max(1, Math.min(n, MAX_FETCH_LIMIT));
};

const normalizeExtension = (ext: string): string => {
  const withDot = ext.startsWith('.') ? ext : `.${ext}`;
  return withDot.toLowerCase();
};

const toItem = (record: CollectionRecord): FileWatcherItem => ({
  record_id: record.record_id,
  received_at: record.received_at,
  modified_at: record.modified_at,
  source_id: record.source_id,
  size_bytes: record.size_bytes,
  hot_fields: { ...record.hot_fields },
});

const matchesPathPrefix = (record: CollectionRecord, prefix: string): boolean => {
  const path = record.hot_fields.path;
  return typeof path === 'string' && path.startsWith(prefix);
};

const matchesExtension = (record: CollectionRecord, ext: string): boolean => {
  const path = record.hot_fields.path;
  if (typeof path !== 'string') return false;
  return path.toLowerCase().endsWith(ext);
};

const matchesSize = (
  record: CollectionRecord,
  min?: number,
  max?: number,
): boolean => {
  const raw = record.hot_fields.size;
  const size = typeof raw === 'number' ? raw : record.size_bytes;
  if (min !== undefined && size < min) return false;
  if (max !== undefined && size > max) return false;
  return true;
};

export const handleFileWatcher = async (
  deps: FileWatcherDeps,
  input: Record<string, unknown>,
): Promise<FileWatcherOutput> => {
  const args = parseArgs(input);
  const now = (deps.now ?? Date.now)();

  const collection = deps.getCollection(args.slug);
  if (!collection || collection.platform !== 'file') {
    return { should_run: false, items: [], last_seen_at: now };
  }

  const outputLimit = resolveLimit(args.limit);
  const needsJsFilter =
    args.path_prefix !== undefined ||
    args.extension !== undefined ||
    args.min_size !== undefined ||
    args.max_size !== undefined;
  const fetchLimit = needsJsFilter
    ? Math.min(outputLimit * OVERFETCH_FACTOR, MAX_FETCH_LIMIT)
    : outputLimit;

  const records = collection.list({
    platform: 'file',
    slug: args.slug,
    ...(args.since !== undefined ? { modified_since: args.since } : {}),
    limit: fetchLimit,
  });

  const normalizedExt = args.extension !== undefined
    ? normalizeExtension(args.extension)
    : undefined;

  const matches: CollectionRecord[] = [];
  for (const record of records) {
    if (args.path_prefix !== undefined && !matchesPathPrefix(record, args.path_prefix)) continue;
    if (normalizedExt !== undefined && !matchesExtension(record, normalizedExt)) continue;
    if (!matchesSize(record, args.min_size, args.max_size)) continue;
    matches.push(record);
    if (matches.length >= outputLimit) break;
  }

  // `collection.list` returns newest-first by received_at; for the
  // modified-at cursor we re-sort ascending by modified_at.
  matches.sort((a, b) => a.modified_at - b.modified_at);

  let maxSeen = args.since ?? 0;
  const items: FileWatcherItem[] = [];
  for (const record of matches) {
    items.push(toItem(record));
    if (record.modified_at > maxSeen) maxSeen = record.modified_at;
  }

  const lastSeenAt = items.length > 0 ? maxSeen : now;

  return {
    should_run: items.length > 0,
    items,
    last_seen_at: lastSeenAt,
  };
};
