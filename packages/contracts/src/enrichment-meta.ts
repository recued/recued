/** D-128 — `meta` snapshot substrate for platform-reference enrichments.
 *
 *  Pure / portable / testable in isolation. Producers in
 *  `backend/server/src/housekeeping/reconciliation/*` + the resolver +
 *  tests share this module. Spec: `docs/d-128-spec.md` §A.2.
 *
 *  Meta is the **enrichment-compute substrate** for
 *  `connection.api.<vendor>.<entity>` rows — a small denormalised
 *  snapshot of the canonical fields a producer reads to compute its
 *  enrichment (deal stage, amount, owner, key dates). Render fallback
 *  / cheap diff at reconciliation / search-by-name fall out of this;
 *  anything Recued already needs for compute, the user can also browse
 *  offline. Hard 8 KB cap per row. */

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** D-128 — hard cap on the serialised `meta` JSON payload. 8 KB leaves
 *  room for richer canonical fields (recent activity timestamps,
 *  owner+team lists, line-item summaries) without forcing producers to
 *  round-trip the vendor for normal compute. Stays well within
 *  SQLite's healthy row-width range. Larger snapshots reject at upsert
 *  with `META_SNAPSHOT_TOO_LARGE`. */
export const PLATFORM_REFERENCE_META_MAX_BYTES = 8192;

/** D-128 — default reconciliation cadence for platform-reference
 *  scopes. User-overridable in Settings → Connections → <connection> →
 *  Reconciliation. Reserved for D-128 P2 (reconciliation harness);
 *  ships unused in P1. */
export const PLATFORM_REFERENCE_DEFAULT_CADENCE = '6h' as const;

/** D-128 — slim-record batch size when walking `listUpdatedSince`.
 *  Reserved for D-128 P2; ships unused in P1. */
export const PLATFORM_REFERENCE_BATCH_SIZE = 200;

/** D-128 — periodic existence-check sweep cadence for vendors without
 *  reliable delete webhooks (most CRMs). Reserved for D-128 P2; ships
 *  unused in P1. */
export const PLATFORM_REFERENCE_DELETE_DETECT_CADENCE = '24h' as const;

/** D-128 — webhook dedup window. Vendor webhooks racing the cycle
 *  reconciler are deduped if the same `(target_id, hash)` pair fires
 *  twice inside this window. Reserved for D-128 P3; ships unused in P1. */
export const PLATFORM_REFERENCE_WEBHOOK_REPLAY_WINDOW_MS = 5 * 60 * 1000;

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/** D-128 — denormalised snapshot of the canonical user-visible fields
 *  on a platform-resident record. Open vocabulary — vendor reconcilers
 *  decide which fields to project (`name` / `status` / key dates / amount /
 *  owner / …) — but every snapshot carries the two stamping fields
 *  below so the cycle reconciler can short-circuit on hash match.
 *
 *  Field shapes that vendors should converge on (not enforced here):
 *  - `name: string`            — canonical display name
 *  - `status: string`          — primary lifecycle field (deal stage,
 *                                issue state, page status)
 *  - `amount: number`          — numeric value if applicable
 *  - `owner: string`           — assignee / owner email or id
 *  - `key_dates: { ... }`      — important timestamps in unix-ms
 *
 *  Vendor-specific extras pass through. Total serialised size hard-capped
 *  at `PLATFORM_REFERENCE_META_MAX_BYTES`. */
export interface EnrichmentMeta {
  /** Unix-ms when this snapshot was last refreshed. Becomes the
   *  enrichment row's `event_at` when the reconciler doesn't otherwise
   *  set one — bistemporal-friendly per D-120 P7.5. */
  snapshot_at: number;
  /** Stable hash of the canonical fields used for cycle skip-on-match.
   *  Vendor's `hashOf(record)` produces this; convention is `<algo>:<hex>`
   *  (e.g. `'fnv1a:8a3f...'`) so the algorithm is self-describing. */
  snapshot_hash: string;
  /** Open-vocabulary additional fields. */
  [field: string]: unknown;
}

// ────────────────────────────────────────────────────────────────
// Errors
// ────────────────────────────────────────────────────────────────

/** D-128 — thrown when a `meta` snapshot serialises to more than
 *  `PLATFORM_REFERENCE_META_MAX_BYTES`. Callers (the enrichment store
 *  upsert path) translate this into a typed RPC error for the recipe
 *  surface; reconcilers catching this should drop or shrink the
 *  snapshot rather than retry. */
export class MetaSnapshotTooLargeError extends Error {
  readonly code = 'META_SNAPSHOT_TOO_LARGE';
  readonly bytes: number;
  readonly cap: number;
  constructor(bytes: number) {
    super(
      `meta_snapshot_too_large: serialised meta is ${bytes} bytes, cap is ${PLATFORM_REFERENCE_META_MAX_BYTES}`,
    );
    this.name = 'MetaSnapshotTooLargeError';
    this.bytes = bytes;
    this.cap = PLATFORM_REFERENCE_META_MAX_BYTES;
  }
}

// ────────────────────────────────────────────────────────────────
// Serializer + deserializer
// ────────────────────────────────────────────────────────────────

/** Cheap structural validator — `meta` must be a non-array object
 *  with the two stamping fields. Returns issue strings on failure;
 *  empty array means OK. */
export const assertEnrichmentMetaShape = (value: unknown): string[] => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return ['meta must be a non-array object'];
  }
  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  if (typeof obj.snapshot_at !== 'number' || !Number.isFinite(obj.snapshot_at)) {
    issues.push('meta.snapshot_at must be a finite number (unix-ms)');
  }
  if (typeof obj.snapshot_hash !== 'string' || obj.snapshot_hash.length === 0) {
    issues.push('meta.snapshot_hash must be a non-empty string');
  }
  return issues;
};

/** Serialise a meta snapshot to JSON, enforcing the 8 KB cap. Returns
 *  the JSON string on success; throws `MetaSnapshotTooLargeError` when
 *  the payload exceeds `PLATFORM_REFERENCE_META_MAX_BYTES`. Byte size
 *  is measured in UTF-8 (matches what SQLite stores). */
export const serializeEnrichmentMeta = (meta: EnrichmentMeta): string => {
  const issues = assertEnrichmentMetaShape(meta);
  if (issues.length > 0) {
    throw new Error(`meta_snapshot_invalid: ${issues.join('; ')}`);
  }
  const json = JSON.stringify(meta);
  const bytes = byteLengthUtf8(json);
  if (bytes > PLATFORM_REFERENCE_META_MAX_BYTES) {
    throw new MetaSnapshotTooLargeError(bytes);
  }
  return json;
};

/** Parse a stored meta JSON string back into a typed `EnrichmentMeta`.
 *  Returns null on `null` / empty / malformed input — the column is
 *  nullable (Shape A and Shape B rows from D-122 carry no meta) and
 *  callers must handle the absence. */
export const deserializeEnrichmentMeta = (raw: string | null): EnrichmentMeta | null => {
  if (raw === null || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (assertEnrichmentMetaShape(parsed).length > 0) return null;
  return parsed as EnrichmentMeta;
};

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

/** UTF-8 byte length of a string. Mirrors `Buffer.byteLength(s, 'utf8')`
 *  without pulling Node `Buffer` into the contracts package (which is
 *  dep-free and runs in browsers). The encoder approach is the
 *  shortest portable path. */
const byteLengthUtf8 = (s: string): number => {
  // Browsers + Node both expose TextEncoder globally; contracts ships
  // ES2022 + DOM lib so this is always available.
  return new TextEncoder().encode(s).length;
};
