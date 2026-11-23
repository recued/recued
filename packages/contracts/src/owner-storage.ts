/** D-403 (D-403) — what takes space on the owner's server, by kind, and a purge the
 *  owner runs: "manual for owner to take action".
 *
 *  The wire shape of `storage.kinds.read`, `storage.purge.preview` and `storage.purge.run`. Counts,
 *  sizes and dates only, never content. */

/** Where a kind sits in the view, in order. */
export const STORAGE_KIND_GROUPS = ['records', 'activity', 'assets', 'copies', 'conversations', 'derived', 'yours'] as const;
export type StorageKindGroup = (typeof STORAGE_KIND_GROUPS)[number];

/** Why a kind can't be purged here, said in one word on its row:
 *  - `yours`: the owner's own (knowledge, shared data), never deleted here;
 *  - `with_source`: derived from other data, it goes when that goes;
 *  - `resyncs`: a copy a sync would bring back;
 *  - `not_yet`: a later slice of D-403. */
export type StorageKindHold = 'yours' | 'with_source' | 'resyncs' | 'not_yet';

/** One kind of stored data. */
export interface StorageKindRow {
  /** Stable id: `records:<publisher>/<pack_slug>/<kind>`, `runs`, `reading_history`, … */
  kind: string;
  group: StorageKindGroup;
  /** The owner's words: "Body signals · Daily metric", "Run history". */
  label: string;
  /** The items it holds: rows, runs, messages. Absent when only its size is known (a copy's gate). */
  items?: number;
  /** What the items are called, plural: "rows", "runs", "messages". */
  item_words: string;
  /** Bytes, where the server already accounts them; absent when it does not. */
  bytes?: number;
  /** Epoch ms of the oldest item, by `purge.by` when the kind can be purged. */
  oldest_at?: number;
  /** Items added in the last 30 days. */
  added_30d?: number;
  /** Present when the owner can delete this kind's items older than a date here. */
  purge?: {
    /** What "older than" counts by: when a row was last saved, a run started, a reading was taken. */
    by: 'saved' | 'started' | 'taken';
    /** The export to offer before deleting, when the kind has one. */
    export?: 'records' | 'runs';
  };
  /** Why it can't be purged here; absent when it can. */
  hold?: StorageKindHold;
}

export interface StorageDatabaseInfo {
  /** The database file's size on disk. */
  file_bytes: number;
  /** Space inside the file that deletes freed, which SQLite fills before the file grows. */
  free_bytes: number;
}

export interface StorageKindsResponse {
  measured_at: number;
  database: StorageDatabaseInfo;
  kinds: StorageKindRow[];
}

export interface StoragePurgePreviewRequest {
  kind: string;
  /** Epoch ms: items older than this go. At least a day ago. */
  before: number;
}

export interface StoragePurgePreview {
  kind: string;
  before: number;
  items: number;
  bytes?: number;
  oldest_at?: number;
  newest_at?: number;
  /** Binds a run to this preview: the same kind, cutoff and count, within `expires_at`. */
  token: string;
  expires_at: number;
}

export interface StoragePurgeRunRequest {
  kind: string;
  before: number;
  token: string;
}

export interface StoragePurgeRunResult {
  kind: string;
  before: number;
  deleted: number;
  /** Items left because something else still points at them (a Records row another row restricts). */
  blocked: number;
  /** Bytes freed inside the database file, where the kind accounts them. */
  bytes_freed?: number;
}

/** How long a preview binds a run. */
export const STORAGE_PURGE_PREVIEW_TTL_MS = 60_000;
/** The newest cutoff a purge takes: nothing from the last day goes. */
export const STORAGE_PURGE_MIN_AGE_MS = 86_400_000;

/** A kind id for a pack's Records kind. */
export const recordsStorageKind = (publisher: string, packSlug: string, kind: string): string => `records:${publisher}/${packSlug}/${kind}`;

/** The pack and kind a Records kind id names, or undefined. */
export const parseRecordsStorageKind = (kind: string): { publisher: string; pack_slug: string; kind: string } | undefined => {
  const match = /^records:([^/\s]+)\/([^/\s]+)\/([^/\s]+)$/u.exec(kind);
  return match ? { publisher: match[1]!, pack_slug: match[2]!, kind: match[3]! } : undefined;
};

/** A key in words: `daily_metric` → "Daily metric", `body-signals` → "Body signals". */
export const storageKeyWords = (key: string): string => {
  const words = key.replace(/[_-]+/gu, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
};
