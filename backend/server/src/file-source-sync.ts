/** D-192 file SOURCE family (slice 4) — the `file_meta_ref` reconcile runner + wire.
 *
 *  The file-family counterpart of `work-entity-source-sync.ts`, sharing its
 *  reconcile spine (list → hash-skip → upsert → complete-walk tombstone) but
 *  MUCH thinner: file Source sync mirrors metadata only and never fetches
 *  bodies (explicit reads resolve remote bytes through a separate lazy path),
 *  read-only in v1 — so there is no P4b dirty-write guard, no P5
 *  work-graph edges, and no native-tombstone field (the thin
 *  `FileVendorDeclaration` carries none). Removals are handled purely by the
 *  D-190 complete-walk delete diff, gated on the walk's POSITIVE completeness
 *  proof.
 *
 *  One cycle, per `(source_id, declaration, connection)`:
 *
 *    1. `listFiles` — the INJECTED per-vendor list port (slice-5 adapter
 *       leaves satisfy it, keyed by the `vendor` slug; slice 4 ships none, so
 *       the wire below registers no task until a leaf exists). Returns raw
 *       vendor file rows + a `complete` proof (the whole scoped tree was
 *       walked to exhaustion) — never bytes.
 *    2. Per row: key by the declared `remote_id` (a row that carries none is
 *       UNKEYABLE — counted, and it poisons the delete proof for the cycle
 *       since we cannot prove it absent); project through the shared
 *       declaration-driven projector; `buildFileMetaSnapshot` (validate +
 *       stamp hash); hash-skip against `listSnapshotHashes` (an unchanged
 *       re-list never re-writes — no warehouse-event churn); upsert.
 *    3. Deletes — `computeCompleteWalkDeletes`, gated on a POSITIVE
 *       completeness proof (`outcome.complete`) AND zero unkeyable rows.
 *       Fail-closed everywhere else: absence proves nothing on a
 *       delta / partial / unproven walk (the D-190 rule).
 *
 *  Delta posture (hybrid): a delta-capable vendor (`list.mode:
 *  'full_then_delta'`, e.g. Dropbox) rides its native cursor — the runner
 *  passes the stored watermark for a cheap changes-only upsert walk, and forces
 *  a FULL re-list (passing `cursor: null`) on first boot and periodically
 *  (`last_full_walk_at` aged past the interval). Two DISTINCT delete signals:
 *   - ABSENCE-based deletes (a prior key not seen this walk) are the full walk's
 *     job ALONE — absence from a delta means "unchanged", not "gone", so a delta
 *     NEVER tombstones by absence (removals it can't see reconcile at the
 *     periodic re-baseline).
 *   - EXPLICIT deletes — a delta's own vendor tombstones ARE authoritative: the
 *     vendor SAID those files are gone, so the runner tombstones them THIS cycle
 *     (no completeness proof — a positive signal), guarded so a move/rename is
 *     never false-deleted. Two keyings, one posture: PATH-keyed tombstones
 *     (`outcome.removed_paths` — Dropbox `deleted` entries, which carry a path
 *     but no id) are reverse-looked-up against the mirror's stored paths to find
 *     the `remote_id`; ID-keyed tombstones (`outcome.removed_keys` — Drive
 *     `changes` `fileId` / Graph `/delta` `id`) delete the mirror key DIRECTLY
 *     (no reverse lookup). So a reported removal propagates on the very next
 *     delta; the periodic full walk backstops anything a delta missed (a
 *     reset-gap deletion).
 *  A `full` vendor (S3, no native delta) full-walks every cycle; hash-skip keeps
 *  an unchanged re-list cheap regardless.
 *
 *  The housekeeping wire mirrors `wireWorkEntitySourceSync`: one `core` task
 *  per connection whose vendor has BOTH a `FileVendorDeclaration` AND a
 *  resolved adapter leaf. It stays `file_meta_ref`-only by construction — it
 *  enumerates the FILE vendor registry, disjoint from the WORK-entity
 *  registry `wireWorkEntitySourceSync` walks — so a file Source can never be
 *  swept by the records runner and vice-versa. */

import type { ConnectionRow, FileVendorDeclaration, ImportScope } from '@recued/contracts';
import {
  CONNECTION_SOURCE_ID,
  compileImportScope,
  getFileVendorDeclaration,
  normalizeScopePath,
} from '@recued/contracts';

import { connectionVendorOf } from './work-entity-source-boot.js';
import { getByDotPath } from './source-mirror/fetch.js';
import { computeCompleteWalkDeletes } from './source-mirror/diff.js';
import { projectFileVendorRow } from './file-source-projector.js';
import {
  buildFileMetaSnapshot,
  type FileMetaStore,
} from './storage/file-meta-store.js';
import {
  FILE_SOURCE_FULL_WALK_INTERVAL_MS,
  initialFileSourceSyncState,
  type FileSourceSyncStateStore,
} from './storage/file-source-sync-state.js';
import type { ConnectionStoreSqlite } from './storage/connection-store.js';
import {
  getHousekeepingTask,
  registerHousekeepingTask,
  unregisterHousekeepingTask,
  type HousekeepingTaskInstance,
} from './housekeeping/registry.js';

// ────────────────────────────────────────────────────────────────
// The injected list port (slice-5 adapter leaves satisfy it)
// ────────────────────────────────────────────────────────────────

export interface FileSourceListRequest {
  source_id: string;
  connection_name: string;
  /** The declaration's `vendor` slug — the leaf keys on it. */
  vendor: string;
  declaration: FileVendorDeclaration;
  /** The delta watermark the runner rides. `null` requests a FULL walk (first
   *  boot, or a periodic delete re-baseline — see the runner). A non-null value
   *  requests a DELTA walk from that watermark (a delta-capable leaf reads it;
   *  a `full` vendor ignores it and full-walks anyway). */
  cursor?: string | null;
}

export type FileSourceListOutcome =
  | {
      ok: true;
      /** Which walk the leaf ran (driven by the `cursor` the runner passed):
       *   - `'full'` — a re-list of the whole (scoped) tree, so this walk is the
       *     DELETE AUTHORITY (absence-based tombstones run when `complete`).
       *     Returned when the runner passed `cursor: null`, and by a
       *     delta-capable leaf that hit a cursor reset (transparent fallback).
       *   - `'delta'` — only the rows CHANGED since the passed watermark. Not
       *     delete-authoritative by ABSENCE (absence from a delta means
       *     "unchanged", not "gone" — the runner runs ZERO absence-tombstones),
       *     but the walk's EXPLICIT vendor tombstones ({@link removed_paths}) ARE
       *     honored this cycle; anything the delta didn't see reconciles on the
       *     next full re-list (the hybrid delete model). */
      walk: 'full' | 'delta';
      /** Raw vendor file rows (metadata only — never bytes). On a `full` walk,
       *  the present-set of the scoped tree; on a `delta` walk, the changed /
       *  added files (upserts). A delta-capable leaf surfaces vendor delete
       *  tombstones separately in {@link removed_paths} (they never enter `rows`
       *  — a tombstone is not a file to project/upsert). */
      rows: ReadonlyArray<Record<string, unknown>>;
      /** Explicit vendor delete tombstones a DELTA walk reported — the PATHS the
       *  vendor SAID are gone (Dropbox `.tag: 'deleted'` entries, which carry a
       *  path but no `id`). A POSITIVE removal signal, so — unlike absence-based
       *  full-walk deletes — it needs NO completeness proof: the runner
       *  reverse-looks each path up against the mirror's stored paths
       *  (`listSourcePaths`) to find the `remote_id` to tombstone, and deletes it
       *  immediately (removals no longer wait for the periodic full re-baseline —
       *  Option 3). A `full` walk omits this (it owns removals by ABSENCE); a
       *  delta walk that saw no removals returns `[]` / omits it. The runner
       *  guards each candidate against this same walk's upserts so a move/rename
       *  (same id, new path) is never false-deleted. A vendor whose tombstones
       *  carry the remote id directly (Drive `fileId`, Graph `id`) uses the
       *  ID-keyed sibling {@link removed_keys} instead — same spine, no reverse
       *  lookup. */
      removed_paths?: readonly string[];
      /** Explicit vendor delete tombstones a DELTA walk reported, keyed by the
       *  vendor's OWN remote id — the ID-keyed sibling of {@link removed_paths},
       *  for vendors whose delete tombstone carries the id directly: Google Drive
       *  `changes.list` entries with `removed: true` (or `file.trashed: true`),
       *  carrying `fileId`; MS Graph `/delta` items carrying a `deleted` facet,
       *  keyed by `id`. Because that id IS the mirror key (`remote_id`), the
       *  runner deletes each row DIRECTLY — none of the path→id reverse lookup the
       *  path-keyed block needs. Same posture as `removed_paths`: a POSITIVE
       *  removal signal (needs NO completeness proof), honored under the SAME
       *  `unkeyable === 0` fail-closed gate, with each key guarded against this
       *  walk's upserts (`polledKeys`) so a delete+re-list pair for one id never
       *  false-deletes the live row. A `full` walk omits it (absence owns
       *  removals); a delta with no removals returns `[]` / omits it. */
      removed_keys?: readonly string[];
      /** The delta watermark to persist for the next cycle — a delta-capable
       *  leaf captures/advances its list endpoint's final cursor here; a `full`
       *  vendor (S3, no native delta) omits it (→ null, so the next cycle
       *  full-walks). `null` from a delta walk ⇒ the leaf could not advance (a
       *  malformed final page) → the next cycle full-walks (fail-safe). */
      next_cursor?: string | null;
      /** The `import_scope` the leaf resolved for this Source (Fork A escape
       *  hatch, slice 6) — a user-declared path glob scoping the mirror to a
       *  subtree. The leaf pushes `scope.prefix` down to the vendor list API
       *  (S3 `Prefix` / a Dropbox parent folder); the runner client-side
       *  filters each walked row's path through the full glob AND (on a full
       *  walk) scopes the delete diff to the prefix. `null` / omitted = full
       *  mirror (no scope). The same glob filter applies to delta upserts. */
      scope?: ImportScope | null;
      /** Positive completeness proof — MEANINGFUL ONLY on a `full` walk, where
       *  it is true iff the leaf PROVABLY walked the ENTIRE scoped tree to
       *  exhaustion (every page fetched); a partial / scoped-early-exit walk is
       *  `false`, so the delete diff fail-closes. A `delta` walk is never
       *  delete-authoritative, so it reports `false`. */
      complete: boolean;
    }
  | {
      ok: false;
      /** `'config'` — the leaf can't list (missing credential / unenrolled);
       *  `'policy'` — a permission gate refused; `'error'` — the call failed;
       *  `'unavailable'` — a transient "nothing to list right now". */
      kind: 'config' | 'policy' | 'error' | 'unavailable';
      reason: string;
    };

export type FileSourceListFn = (request: FileSourceListRequest) => Promise<FileSourceListOutcome>;

/** Resolve the per-vendor list leaf. Absent / returns `undefined` (slice 4)
 *  → the vendor has no adapter leaf yet, so no Source gets a sync task (the
 *  meta-store + wiring stand ready; slice 5's leaves are what light the tasks
 *  up). */
export type FileSourceAdapterResolver = (vendor: string) => FileSourceListFn | undefined;

// ────────────────────────────────────────────────────────────────
// Runner
// ────────────────────────────────────────────────────────────────

export interface FileSourceSyncDeps {
  store: FileMetaStore;
  /** The per-Source runtime health/cursor row — the runner records the cycle
   *  outcome here (replacing the slice-4 audit-row stopgap), and it is the
   *  freshness input the `source_freshness_degradation` reader consumes. */
  syncState: FileSourceSyncStateStore;
  /** The resolved list leaf for THIS Source's vendor (the wire resolves it;
   *  tests inject a stub). */
  listFiles: FileSourceListFn;
  now?: () => number;
}

export interface FileSourceSyncInput {
  source_id: string;
  connection_name: string;
  declaration: FileVendorDeclaration;
}

export type FileSourceSyncResult =
  | {
      ok: true;
      upserted: number;
      unchanged: number;
      deleted: number;
      /** Rows we could not project / validate (present remotely — never
       *  entered the delete diff as absent). */
      failed_rows: number;
      /** Rows carrying no keyable `remote_id` — poisons the delete proof
       *  for the cycle (a row we cannot key is a row we cannot prove absent). */
      unkeyable: number;
      /** The walk's positive completeness proof (delete-diff gate). A delta
       *  walk is never delete-authoritative, so it reports `false`. */
      complete: boolean;
      /** Which walk ran — `'full'` re-lists the whole tree (delete authority);
       *  `'delta'` upserts only the changes since the watermark. */
      walk: 'full' | 'delta';
    }
  | { ok: false; kind: 'config' | 'policy' | 'error' | 'unavailable'; reason: string };

/** The prior mirror keys ELIGIBLE for absence-based tombstoning this cycle.
 *  Without a scope (or a root scope, `prefix === ''`) every prior key is
 *  eligible — the walk covered the whole tree. Under a prefix-bounded scope,
 *  only keys whose STORED path is under the prefix are eligible: the walk only
 *  PROVED that subtree, so anything outside it must not be tombstoned even on a
 *  `complete` walk (D-190 fail-closed). Reads the stored paths once. */
const scopedPriorKeys = (
  store: FileMetaStore,
  source_id: string,
  priorHashes: Map<string, string>,
  scope: ImportScope | null | undefined,
): Iterable<string> => {
  if (!scope || scope.prefix.length === 0) return priorHashes.keys();
  const storedPaths = store.listSourcePaths(source_id);
  const eligible: string[] = [];
  for (const key of priorHashes.keys()) {
    const sp = storedPaths.get(key);
    if (sp !== undefined && normalizeScopePath(sp).startsWith(scope.prefix)) eligible.push(key);
  }
  return eligible;
};

/** Invert the mirror's `target_id → stored path` map into `normalized path →
 *  the keys stored at it` — the reverse-lookup an EXPLICIT delta delete needs (a
 *  vendor delete tombstone names a PATH; the mirror keys on `remote_id`). The
 *  path is normalized (a single leading `/` stripped, {@link normalizeScopePath})
 *  so a Dropbox `path_display` tombstone matches the stored `path_display`
 *  uniformly. A Set (not a scalar) so a transient path COLLISION resolves to
 *  BOTH keys — a stale row not yet tombstoned that shares a path with a freshly
 *  re-created one (path reuse); the caller's `polledKeys` guard then keeps the
 *  live (this-walk) key and tombstones only the stale one. */
const invertStoredPaths = (stored: Map<string, string>): Map<string, Set<string>> => {
  const out = new Map<string, Set<string>>();
  for (const [key, path] of stored) {
    const norm = normalizeScopePath(path);
    const set = out.get(norm);
    if (set === undefined) out.set(norm, new Set([key]));
    else set.add(key);
  }
  return out;
};

/** Run one sync cycle for a declared file Source. Returns the cycle outcome;
 *  a fetch failure surfaces as `{ ok: false }`, a per-row failure degrades
 *  the cycle counts without failing it (the other rows still land). */
export const runFileSourceSync = async (
  deps: FileSourceSyncDeps,
  input: FileSourceSyncInput,
): Promise<FileSourceSyncResult> => {
  const { store, syncState, listFiles } = deps;
  const now = deps.now ?? ((): number => Date.now());
  const { source_id, connection_name, declaration } = input;

  syncState.markStarted(source_id, now());

  // ── full-vs-delta decision (the hybrid cursor model) ──────────
  // Ride a delta ONLY when the vendor declares one (`full_then_delta`), we hold
  // a watermark, AND the delete-authority full walk is not yet due. Otherwise
  // pass `cursor: null` to force a FULL re-list — first boot (no watermark),
  // the periodic re-baseline (`last_full_walk_at` aged past the interval, so
  // removals reconcile), or a `full` vendor (S3 never holds a cursor). The leaf
  // keys off the passed cursor: null ⇒ full, non-null ⇒ delta (with a
  // transparent full fallback on a vendor cursor reset).
  const state = syncState.get(source_id);
  const deltaCapable = declaration.list.mode === 'full_then_delta';
  const storedCursor = state?.cursor_blob ?? null;
  const lastFullWalkAt = state?.last_full_walk_at ?? null;
  const fullDue =
    lastFullWalkAt === null || now() - lastFullWalkAt >= FILE_SOURCE_FULL_WALK_INTERVAL_MS;
  const requestCursor = deltaCapable && storedCursor !== null && !fullDue ? storedCursor : null;

  // ── the injected list fetch (metadata only) ───────────────────
  const outcome = await listFiles({
    source_id,
    connection_name,
    vendor: declaration.vendor,
    declaration,
    cursor: requestCursor,
  });
  if (!outcome.ok) {
    // A fetch failure (missing credential / vendor error / transient) is a
    // recorded, retried-next-cycle outcome — degraded, no `last_success_at` bump.
    syncState.markCompleted(source_id, {
      ok: false,
      error_code: `fetch_${outcome.kind}`,
      error_message: outcome.reason,
      now: now(),
    });
    return { ok: false, kind: outcome.kind, reason: outcome.reason };
  }

  // ── import_scope (Fork A) — the client-side narrowing half ─────
  // The leaf pushed `scope.prefix` down to the vendor list API (so the walk is
  // already prefix-bounded); here we filter each walked row's path through the
  // FULL glob. This handles the non-prefix pattern (`**/*.pdf`), a vendor that
  // couldn't push the prefix down, and a Dropbox folder pushdown broader than
  // the glob. The filter runs per row inside the loop (AFTER keying, so a
  // present-but-path-unreadable row is kept, never false-deleted).
  const compiledScope = outcome.scope ? compileImportScope(outcome.scope) : null;
  const pathField = declaration.projection.path;

  // ── per-row: scope-filter / key / project / hash-skip / upsert ─
  const priorHashes = store.listSnapshotHashes(source_id);
  const polledKeys = new Set<string>();
  let upserted = 0;
  let unchanged = 0;
  let failed_rows = 0;
  let unkeyable = 0;

  for (const raw of outcome.rows) {
    // Key FIRST (before projection) so a row that fails to PROJECT is still
    // recorded as present (it must never enter the delete diff as absent),
    // while a row with no keyable id is UNKEYABLE — counted, and it will
    // fail-close the delete proof below.
    const rawKey = getByDotPath(raw, declaration.projection.remote_id);
    const key = typeof rawKey === 'string'
      ? rawKey
      : typeof rawKey === 'number' ? String(rawKey) : '';
    if (key.length === 0) {
      unkeyable += 1;
      continue;
    }

    // Scope filter — three outcomes for a KEYED row under an active scope:
    //   • path unreadable ⇒ PRESENT but can't confirm in-scope: keep it in
    //     `polledKeys` (so a complete walk never false-deletes a present row —
    //     the D-190 rule) and count it degraded; don't upsert (no valid path).
    //   • path present but OUT of the glob ⇒ proven out-of-scope (the leaf
    //     walked it, the glob rejected it): drop it — NOT in `polledKeys`, so
    //     a narrowed glob correctly tombstones it (bounded to the prefix below).
    //   • in scope ⇒ fall through to project + upsert.
    // `pathField === undefined` (a vendor with no declared path) can't be
    // scope-filtered per-row — impossible for the shipped S3/Dropbox vendors;
    // the leaf pushdown still bounded the walk, so such rows fall through.
    if (compiledScope && pathField !== undefined) {
      const rawPath = getByDotPath(raw, pathField);
      if (typeof rawPath !== 'string') {
        failed_rows += 1;
        polledKeys.add(key);
        continue;
      }
      if (!compiledScope.matches(rawPath)) continue;
    }
    polledKeys.add(key);

    const projected = projectFileVendorRow(raw, declaration);
    if (!projected.ok) {
      failed_rows += 1;
      continue;
    }
    try {
      // `buildFileMetaSnapshot` validates fail-closed (empty required field,
      // over-cap) + stamps the hash; the upsert enforces the blob cap. A throw
      // from either is a row failure (present, unchanged in the mirror), never
      // a cycle abort — the remaining rows still land.
      const snapshot = buildFileMetaSnapshot(projected.projection, now());
      if (priorHashes.get(key) === snapshot.snapshot_hash) {
        unchanged += 1;
        continue;
      }
      store.upsert({ scope: source_id, target_id: key, meta: snapshot, now: now() });
      upserted += 1;
    } catch {
      failed_rows += 1;
    }
  }

  // ── absence-based deletes — FULL walk only, fail-closed ───────
  // A delta walk is NEVER delete-authoritative: absence from it means
  // "unchanged", not "gone", so tombstones run ONLY on a full re-list (the
  // hybrid delete model — removals reconcile at the periodic re-baseline). On a
  // full walk, the same fail-closed gate as before: a POSITIVE completeness
  // proof from the list leaf (`complete`, never `!truncated`) AND zero unkeyable
  // rows (a row we could not key is a row we cannot prove absent). Anything
  // less ⇒ zero deletes this cycle.
  //
  // Under an `import_scope`, `complete` means "the whole SCOPED (prefix-bounded)
  // tree was walked" — NOT the whole bucket/account — so a prior row is a delete
  // candidate ONLY when its STORED path is under the scope prefix (the walked
  // subtree). This bounds tombstones to the region the walk PROVED, uniformly
  // for a path-keyed vendor (S3) AND an opaque-keyed one (Dropbox `id`, which a
  // key-prefix test can't reach): narrowing `Work/**` → `Work/2024/**` never
  // tombstones the un-walked `Work/2025/*` (D-190 fail-closed), while a same-
  // prefix glob narrowing still cleans up rows the walk saw + rejected. A row
  // whose stored path can't be read is omitted by `listSourcePaths` → never a
  // candidate. Without a scope, every prior key is eligible (full mirror).
  let deleted = 0;
  if (outcome.walk === 'full' && outcome.complete && unkeyable === 0) {
    const priorKeysForDiff = scopedPriorKeys(store, source_id, priorHashes, outcome.scope);
    for (const gone of computeCompleteWalkDeletes({
      complete: outcome.complete,
      priorKeys: priorKeysForDiff,
      polledKeys,
    })) {
      if (store.deleteForSource(source_id, gone)) deleted += 1;
    }
  }

  // ── explicit delta deletes — POSITIVE vendor tombstones (Option 3) ─────
  // A delta walk is never delete-authoritative by ABSENCE (handled above —
  // full walks only). But the vendor's OWN delete tombstones ARE authoritative:
  // the vendor SAID these paths are gone, so we tombstone them THIS cycle
  // instead of waiting for the periodic full re-baseline (closing the hybrid
  // delete-lag). A positive signal, not an inference from absence, so NO
  // completeness proof is required — but the SAME `unkeyable === 0` gate as the
  // absence block applies (below).
  //
  // Dropbox tombstones are PATH-keyed (a `deleted` entry carries no `id`) while
  // the mirror keys on `remote_id`, so reverse-look each removed path up against
  // the mirror's stored paths. MOVE/RENAME SAFETY (the crux): Dropbox keeps a
  // file's `id` across a move and reports it as `deleted <old path>` +
  // `file <new path>` (same id) — so NEVER tombstone a key this same walk
  // upserted or saw (`polledKeys`). Three independent guards make that safe:
  //   1. the reverse map is read AFTER the upsert loop, so a moved file already
  //      maps to its NEW path — its OLD path resolves to no key (a no-op);
  //   2. `polledKeys` covers the residual case where the move's new-path row
  //      FAILED to project (still keyed → in `polledKeys` → skipped), and lets
  //      path-reuse tombstone only the stale key sharing the path; and
  //   3. the `unkeyable === 0` gate: an UNKEYABLE row (a changed file carrying
  //      no `id`) is a file we could not identify — it may be the move
  //      DESTINATION of one of these removed paths, and since we can't correlate
  //      it to a key, we can't prove any tombstone here isn't that move's old
  //      side. So if ANY row was unkeyable we suppress ALL explicit deletes this
  //      cycle (fail-closed, exactly as absence-deletes do). The cycle is
  //      degraded ⇒ the cursor holds ⇒ the delta replays (idempotently) once the
  //      row keys cleanly; the periodic full walk backstops regardless.
  // A resolved key ABSENT from this walk is a genuine removal (or a move OUT of
  // the mirror's scope — correctly dropped: the file left the mirror).
  if (unkeyable === 0 && outcome.removed_paths && outcome.removed_paths.length > 0) {
    const pathToKeys = invertStoredPaths(store.listSourcePaths(source_id));
    for (const removedPath of outcome.removed_paths) {
      const keys = pathToKeys.get(normalizeScopePath(removedPath));
      if (keys === undefined) continue; // no mirror row at that path — nothing to remove
      for (const key of keys) {
        if (polledKeys.has(key)) continue; // moved/reused this walk — keep the live row
        if (store.deleteForSource(source_id, key)) deleted += 1;
      }
    }
  }

  // ── explicit delta deletes — ID-keyed vendor tombstones (Option 3 sibling) ──
  // The ID-keyed analog of the `removed_paths` block above, for vendors whose
  // delete tombstone carries the remote id directly (Google Drive `changes`
  // `fileId` on a `removed`/`trashed` change; MS Graph `/delta` items with a
  // `deleted` facet, keyed by `id`). Because the tombstone id IS the mirror key
  // (`remote_id`), there is NO path→id reverse lookup — delete each row directly.
  // Same fail-closed posture as the path block: a POSITIVE signal (no
  // completeness proof) under the SAME `unkeyable === 0` gate, with each key
  // guarded against this same walk's upserts (`polledKeys`). Drive/Graph report a
  // MOVE as an updated (not removed) item, so a normal move never tombstones —
  // but the `polledKeys` guard still fail-safes a delete+re-list pair for one id
  // (delete-then-recreate, or a vendor that emits both in one drain): the
  // re-listed row is in `polledKeys`, so the tombstone is skipped and the upsert
  // wins. A resolved key ABSENT from this walk is a genuine removal.
  if (unkeyable === 0 && outcome.removed_keys && outcome.removed_keys.length > 0) {
    for (const key of outcome.removed_keys) {
      if (polledKeys.has(key)) continue; // re-listed/moved this walk — keep the live row
      if (store.deleteForSource(source_id, key)) deleted += 1;
    }
  }

  // ── record the cycle on the sync-state row ────────────────────
  // A partial cycle (a row failed projection OR carried no keyable id) landed
  // its good rows but is DEGRADED: record the error + set degraded WITHOUT
  // bumping `last_success_at` OR the cursor/full-walk watermarks, so the
  // freshness reader treats the Source as stale AND the next cycle re-attempts
  // the SAME walk (a degraded full re-baselines again; a degraded delta replays
  // idempotently from the un-advanced cursor). A clean cycle bumps success +
  // advances the cursor to the leaf's `next_cursor`, and a clean FULL walk also
  // stamps `last_full_walk_at` (the delete-authority watermark that gates the
  // next re-baseline).
  if (failed_rows > 0 || unkeyable > 0) {
    const parts: string[] = [];
    if (failed_rows > 0) parts.push(`${failed_rows} row(s) failed projection`);
    if (unkeyable > 0) parts.push(`${unkeyable} row(s) carried no keyable remote_id`);
    syncState.markCompleted(source_id, {
      ok: false,
      error_code: failed_rows > 0 ? 'projection_failed' : 'rows_unkeyed',
      error_message: parts.join('; '),
      now: now(),
    });
  } else {
    syncState.markCompleted(source_id, {
      ok: true,
      cursor_blob: outcome.next_cursor ?? null,
      full_walk: outcome.walk === 'full',
      now: now(),
    });
  }

  return {
    ok: true,
    upserted,
    unchanged,
    deleted,
    failed_rows,
    unkeyable,
    complete: outcome.complete, // delta walks report false (never delete-authoritative)
    walk: outcome.walk,
  };
};

// ────────────────────────────────────────────────────────────────
// Housekeeping task + wire
// ────────────────────────────────────────────────────────────────

export const fileSourceSyncTaskId = (source_id: string): string =>
  `file-source-sync.${source_id}`;

const buildFileSourceSyncTask = (
  deps: FileSourceSyncDeps,
  input: FileSourceSyncInput,
): HousekeepingTaskInstance => ({
  meta: {
    id: fileSourceSyncTaskId(input.source_id),
    description:
      `Sync file Source '${input.source_id}' from connection '${input.connection_name}'`,
    // One list walk per cycle — no mid-walk checkpoint.
    interruptible: false,
    kind: 'core',
    idle_eligible: true,
  },
  async step(ctx, _cursor, _budget_ms) {
    // Health lives on the `file_source_sync_state` row (`runFileSourceSync`
    // records started/completed there — the freshness reader's input),
    // replacing the slice-4 audit-row stopgap. A failed / degraded cycle is a
    // recorded outcome, NOT a task error: an operational failure — a missing
    // credential, a transient vendor error, a single unprojectable row — is
    // retried next idle window, so we never throw (the scheduler's
    // error/disable machinery is reserved for programming errors).
    await runFileSourceSync({ ...deps, now: deps.now ?? ctx.now }, input);
    return { status: 'complete', cursor: { kind: 'complete' } };
  },
});

interface DesiredFileSource {
  id: string;
  connection_name: string;
  declaration: FileVendorDeclaration;
  listFiles: FileSourceListFn;
}

/** Resolve the file Source (if any) for one connection row: the row's vendor
 *  must have a `FileVendorDeclaration` AND a resolved adapter leaf. Zero or
 *  one per connection (a connection is one vendor). */
const desiredFileSourcesFor = (
  row: ConnectionRow,
  resolveAdapter: FileSourceAdapterResolver,
): DesiredFileSource[] => {
  const vendor = connectionVendorOf(row);
  if (vendor === null) return [];
  const declaration = getFileVendorDeclaration(vendor);
  if (declaration === null) return [];
  const listFiles = resolveAdapter(vendor);
  if (listFiles === undefined) return []; // no adapter leaf yet (slice 4)
  return [{
    id: CONNECTION_SOURCE_ID(vendor, row.name, 'file'),
    connection_name: row.name,
    declaration,
    listFiles,
  }];
};

export interface WireFileSourceSyncInput {
  connectionStore: ConnectionStoreSqlite;
  store: FileMetaStore;
  /** Per-Source runtime health/cursor store. Seeded (if absent) when a Source's
   *  task is registered, deleted when it is unregistered, and written by the
   *  runner each cycle. */
  syncState: FileSourceSyncStateStore;
  /** Resolve the per-vendor list leaf. Absent (slice 4) → no Source gets a
   *  sync task; the wire attaches its connection observers so a later
   *  resolver (slice 5's composed leaves) lights the tasks up with no wiring
   *  change. */
  resolveAdapter?: FileSourceAdapterResolver;
  now?: () => number;
}

/** Wire one housekeeping sync task per file Source (a connection whose vendor
 *  has a declaration + an adapter leaf). Idempotent boot scan + upsert/delete
 *  observers on the connection store, mirroring `wireWorkEntitySourceSync`. */
export const wireFileSourceSync = (input: WireFileSourceSyncInput): void => {
  const { connectionStore, store, syncState, resolveAdapter } = input;

  // Task ids this wire registered, per connection name → the task's source_id —
  // exact deregistration + sync-state cleanup on vendor flips / deletes without
  // re-deriving from the (gone) row.
  const registered = new Map<string, Map<string, string>>();

  const reconcile = (row: ConnectionRow | null, connection_name: string): void => {
    const desired = row === null || resolveAdapter === undefined
      ? []
      : desiredFileSourcesFor(row, resolveAdapter);
    const desiredByTaskId = new Map(
      desired.map((d) => [fileSourceSyncTaskId(d.id), d] as const),
    );
    const current = registered.get(connection_name) ?? new Map<string, string>();
    for (const [taskId, source_id] of [...current]) {
      if (!desiredByTaskId.has(taskId)) {
        unregisterHousekeepingTask(taskId);
        // The sync-state row is runtime state — it dies with the task.
        syncState.deleteForSource(source_id);
        current.delete(taskId);
      }
    }
    for (const [taskId, d] of desiredByTaskId) {
      if (getHousekeepingTask(taskId) === undefined) {
        // Seed the health row at registration (seed-if-absent preserves health
        // across boot re-scans; a fresh Source starts never-synced), so the
        // runner's `markStarted` / `markCompleted` UPDATEs always have a row.
        if (syncState.get(d.id) === null) {
          syncState.upsert(initialFileSourceSyncState(d.id));
        }
        registerHousekeepingTask(buildFileSourceSyncTask(
          { store, syncState, listFiles: d.listFiles, ...(input.now ? { now: input.now } : {}) },
          { source_id: d.id, connection_name, declaration: d.declaration },
        ));
      }
      current.set(taskId, d.id);
    }
    if (current.size > 0) registered.set(connection_name, current);
    else registered.delete(connection_name);
  };

  // Boot scan — every already-enrolled api connection.
  for (const row of connectionStore.list({ kind: 'api' })) reconcile(row, row.name);

  // Future enrollments + vendor flips. Non-api upserts are ignored (a non-api
  // row may coexist with an api row under the same name).
  connectionStore.addOnUpsert((row) => {
    if (row.kind === 'api') reconcile(row, row.name);
  });

  // Deletions — the desired set is empty; every task this wire registered for
  // the name deregisters.
  connectionStore.addOnDelete((kind, name) => {
    if (kind === 'api') reconcile(null, name);
  });
};
