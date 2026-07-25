/** D-192 S4c2 — the GENERIC `delta_cursor` engagement reconciler.
 *
 *  The reusable de-hardcode every future `sync_kind: 'delta_cursor'` engagement
 *  vendor rides (Microsoft Dynamics 365 is the forcing function; the survey is
 *  `docs/d-192-dynamics-declaration-survey.md`, Wall-D). It is to the engagement
 *  plane what `buildCanonicalCrmReconciler` (D-190) is to the CRM record plane:
 *  ONE factory that plugs into the SAME `buildVendorReconciliationTask` harness —
 *  connection-enroll + cursor + rate-gate — and writes the `engagements` table +
 *  `engagement_edges` via `ingestEngagementWithEdges` exactly like the bespoke
 *  HubSpot / Salesforce engagement reconcilers, with ZERO per-vendor code beyond a
 *  thin OData leaf.
 *
 *  What is GENERIC here (written once, tested once):
 *    - the delta drain (`drainIdKeyedDelta`, the file-source Kernel-A spine —
 *      last-occurrence-wins fold + undrained suppression, reused verbatim; only
 *      its file-source *shapers* are bypassed, the drain core is substrate-neutral);
 *    - the opaque-cursor lifecycle: load the prior `$deltatoken`/deltaLink before a
 *      walk, persist the new terminal watermark ONLY on a drained walk (an undrained
 *      final page holds the prior token — never advance a cursor a partial walk
 *      couldn't finish), threaded through the harness `delta` hook + the
 *      `{ kind: 'delta', token }` cursor;
 *    - the flat `meta` projection: read DECLARATIVELY from the entity's
 *      `meta_fields[].source_path` (the pack declaration), so a pack author gets the
 *      canonical snapshot for free;
 *    - the write wiring: `selfIngest` → per-vendor projector → `ingestEngagementWithEdges`;
 *    - delete handling: a delta tombstone (`removed_keys`) → `engagementStore.tombstone`,
 *      applied ONLY on a drained (trustworthy) walk, idempotent across re-walks.
 *
 *  What stays a per-vendor THIN LEAF (irreducibly per-vendor — the evidence-quality
 *  state machines can't be declared): the `GenericEngagementLeaf` closures — OData
 *  fetch / parse / classify (the drain deps), the target-id composition + native-id
 *  / modified-at readers, the `project` (authorship / direction / lifecycle_state /
 *  event_at / body_state / tz — see the Salesforce reconcilers for the shape), and
 *  the `mapEdges` participant fan-out (Dynamics `activityparty`, analog of
 *  Salesforce `TaskRelation`).
 *
 *  Spec: `docs/d-192-engagement-facet.md` (S4c2); survey Wall-D. */

import {
  type ConnectionRecord,
  type ConnectionVendorEntity,
  type EngagementRow,
} from '@recued/contracts';

import type {
  EngagementStore,
  UpsertEdgeInput,
} from '../storage/engagement-store.js';
import type {
  DeltaCursorReconciler,
  ReconciliationCadence,
  SlimRecord,
  VendorReconciler,
} from '../housekeeping/reconciliation/vendor-reconciler.js';
import { drainIdKeyedDelta, type IdKeyedDeltaDeps } from '../file-source-adapters/id-keyed-delta.js';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/** SlimRecord variant carrying the raw vendor delta record. The harness reads
 *  only `id` + `modified_at`; `selfIngest` re-projects from `_raw` (mirrors the
 *  bespoke Salesforce engagement reconcilers' `_raw` slim). */
export interface GenericEngagementSlimRecord extends SlimRecord {
  _raw: Record<string, unknown>;
}

/** Input to the per-vendor evidence-quality projector. The factory pre-composes
 *  `target_id` (via the leaf's `composeTargetId`) and the flat `meta` (declaratively
 *  from `meta_fields[].source_path`); the leaf fills the derived row fields. */
export interface GenericEngagementProjectInput {
  connection_id: string;
  raw: Record<string, unknown>;
  /** Pre-composed engagement `target_id` (`<vendor>_<entity>_<nativeId>`). The
   *  leaf MUST use this for `row.target_id` so upserts + delete tombstones (which
   *  the factory composes with the same `composeTargetId`) never drift. */
  target_id: string;
  /** Flat canonical snapshot, projected declaratively from the entity's
   *  `meta_fields[].source_path`. The leaf assigns it to `row.meta` verbatim. */
  meta: Record<string, unknown>;
  now: number;
}

export interface GenericEngagementEdgeInput {
  connection_id: string;
  raw: Record<string, unknown>;
  target_id: string;
  now: number;
}

/** The irreducibly per-vendor leaf — a thin set of closures a delta-cursor
 *  engagement vendor supplies. Everything else is generic (see the module doc). */
export interface GenericEngagementLeaf {
  /** Build the per-connection delta-drain closures (fetch / parse / classify).
   *  The connection's auth is closed over here, so the drain deps are
   *  connection-scoped. `classify` MUST key files + tombstones on the NATIVE
   *  vendor id (the fold key) — the same id `readNativeId` reads off an upsert
   *  row and `composeTargetId` maps to a `target_id`. */
  buildDelta(connection: ConnectionRecord): IdKeyedDeltaDeps;
  /** The from-scratch start ref for a cold walk (prior token `''`). Typically a
   *  base `/<entity>/delta` URL; a warm cycle drains the deltaLink verbatim. */
  coldStartRef(connection: ConnectionRecord): string;
  /** Native vendor id → engagement `target_id`. Used for BOTH the projected
   *  row's target_id (via `project`) AND delete tombstones, so the two can't
   *  drift. */
  composeTargetId(nativeId: string): string;
  /** Native vendor id off a raw upsert record (for the SlimRecord id +
   *  target-id composition). Null on a record with no usable id → skipped. */
  readNativeId(raw: Record<string, unknown>): string | null;
  /** modified-at (unix-ms) off a raw record — the SlimRecord cursor field. */
  readModifiedAt(raw: Record<string, unknown>): number;
  /** The per-vendor evidence-quality projection: raw → EngagementRow. */
  project(input: GenericEngagementProjectInput): EngagementRow;
  /** The per-vendor participant fan-out → engagement edges (Dynamics
   *  `activityparty`). Returns the full active edge set at write time (the store
   *  diffs + tombstones edges that disappeared). */
  mapEdges(input: GenericEngagementEdgeInput): UpsertEdgeInput[];
  /** Optional — classify a drain error as an expired/invalid delta cursor (MS
   *  Graph `410 Gone` on a stale `@odata.deltaLink`). When it returns true on a
   *  WARM walk, the factory recovers by re-draining once from `coldStartRef` (a
   *  from-scratch full delta); a cold-start error, or any error this rejects, is
   *  a real failure and propagates (the harness step errors + retries next idle
   *  window). Absent ⇒ never a reset (a fake / never-expiring vendor). */
  isResetError?(err: unknown): boolean;
}

export interface BuildGenericEngagementReconcilerInput {
  /** The live-registry vendor-entity — carries `vendor`, `entity`, the
   *  `engagement` facet (must be `sync_kind: 'delta_cursor'`), and the
   *  `meta_fields` the flat projection reads. */
  entity: ConnectionVendorEntity;
  /** The engagement store the reconciler owns (ingest + delete tombstone). */
  engagementStore: EngagementStore;
  /** The per-vendor thin leaf. */
  leaf: GenericEngagementLeaf;
  /** Wall-clock. Defaults to `Date.now`; tests pin it. */
  now?: () => number;
  /** Default polling cadence. Defaults to `'6h'`. */
  cadence?: ReconciliationCadence;
  /** Actor stamped on delete tombstones. Defaults to `reconciler:<vendor>`. */
  tombstoneActor?: string;
}

// ────────────────────────────────────────────────────────────────
// Flat meta projection — the declarative payoff
// ────────────────────────────────────────────────────────────────

/** Read a dotted source path off a raw record. Null-safe end to end (a missing
 *  segment / non-object mid-path yields undefined). Mirrors the resolver's naive
 *  dot-path read the registry `source_path` is authored against. */
export const readDottedPath = (raw: unknown, path: string): unknown => {
  let cur: unknown = raw;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
};

/** Project the flat canonical `meta` snapshot from a raw record + the entity's
 *  declared `meta_fields`. Only `source_path` fields project (DERIVED fields —
 *  no single source — are the leaf's job on the typed row, exactly as
 *  `vendorEntitiesFromComposition` skips them at lift). An absent value is
 *  omitted (not written as `undefined`), so the snapshot carries only present
 *  fields — the same shape the bespoke projectors build. */
export const projectFlatMeta = (
  raw: Record<string, unknown>,
  entity: ConnectionVendorEntity,
): Record<string, unknown> => {
  const meta: Record<string, unknown> = {};
  for (const field of entity.meta_fields) {
    if (field.source_path === undefined) continue; // derived / not declaratively projectable
    const value = readDottedPath(raw, field.source_path);
    if (value !== undefined && value !== null) meta[field.key] = value;
  }
  return meta;
};

// ────────────────────────────────────────────────────────────────
// Factory
// ────────────────────────────────────────────────────────────────

/** Build a generic `delta_cursor` engagement `VendorReconciler` for the given
 *  live-registry entity + per-vendor leaf. Carries `selfIngest` (the engagement
 *  write) + `delta` (the opaque-cursor hook) — never `hashOf`/`toMeta` (it owns
 *  its write, so the harness skips its default enrichment path). */
export const buildGenericEngagementReconciler = (
  input: BuildGenericEngagementReconcilerInput,
): VendorReconciler => {
  const { entity, engagementStore, leaf } = input;
  const facet = entity.engagement;
  if (facet === undefined || facet.sync_kind !== 'delta_cursor') {
    // Fail loud at construction — the boot only builds this for a delta_cursor
    // engagement entity; a misconfigured entity is a boot bug, not a routine path.
    throw new Error(
      `buildGenericEngagementReconciler: entity '${entity.vendor}.${entity.entity}' is not a ` +
        `delta_cursor engagement entity (engagement=${JSON.stringify(facet)})`,
    );
  }
  const vendor = entity.vendor;
  const entityName = entity.entity;
  const now = input.now ?? ((): number => Date.now());
  const default_cadence: ReconciliationCadence = input.cadence ?? '6h';
  const tombstoneActor = input.tombstoneActor ?? `reconciler:${vendor}`;

  // Per-connection stashes (the `canonical-crm-reconciler.ts` closure-Map pattern).
  // `startRefByConn` — the prior token the harness handed via `loadStartRef`, read
  // by `listUpdatedSince`. `watermarkByConn` — the new terminal watermark the walk
  // reached (or null when undrained / not yet walked), taken + cleared by the harness
  // via `takeWatermark`. Keyed by connection so concurrent steps for different
  // connections of the same vendor never cross.
  const startRefByConn = new Map<string, string>();
  const watermarkByConn = new Map<string, string | null>();
  // Real `fetchPage` count for the LAST walk of each connection (incl. a reset
  // re-drain) — surfaced via `apiCallsFor` so the rate gate charges the true page
  // cost, not the harness's `ceil(processed/batch)` estimate (a delta page of pure
  // tombstones processes 0 records but still costs one fetch).
  const pagesByConn = new Map<string, number>();

  const delta: DeltaCursorReconciler = {
    loadStartRef(connection_name: string, token: string): void {
      startRefByConn.set(connection_name, token);
    },
    takeWatermark(connection_name: string): string | null {
      const w = watermarkByConn.get(connection_name) ?? null;
      watermarkByConn.delete(connection_name);
      return w;
    },
  };

  return {
    vendor,
    entity: entityName,
    default_cadence,
    delta,
    async *listUpdatedSince(
      connection: ConnectionRecord,
      _cursor: number,
      _limit: number,
    ): AsyncIterable<GenericEngagementSlimRecord> {
      // Fresh walk for this connection — clear any stale watermark so a generator
      // suspended before the drain below leaves no stale token for `takeWatermark`
      // (fail-safe: a missing entry → the harness holds the prior token).
      watermarkByConn.delete(connection.name);
      const priorToken = startRefByConn.get(connection.name) ?? '';
      const warm = priorToken !== '';
      const startRef = warm ? priorToken : leaf.coldStartRef(connection);

      // Drain the whole delta from `startRef` to its terminal watermark (Kernel-A
      // last-wins fold: an id ending `deleted` is in `removedKeys`, never `rows`).
      // Reset recovery: an expired deltaLink (MS Graph `410 Gone`) on a WARM walk
      // is recoverable by re-draining once from scratch — the token we held is
      // stale but the entity set isn't. Only recover a warm reset (a cold-start
      // reset is a real failure); any non-reset error propagates.
      // Count every `fetchPage` (across the walk + any reset re-drain) so
      // `apiCallsFor` charges the rate gate the true page cost.
      let pageFetches = 0;
      const baseDeps = leaf.buildDelta(connection);
      const deltaDeps: IdKeyedDeltaDeps = {
        ...baseDeps,
        fetchPage: (ref: string): Promise<unknown> => {
          pageFetches += 1;
          return baseDeps.fetchPage(ref);
        },
      };
      let drain;
      try {
        drain = await drainIdKeyedDelta(deltaDeps, startRef);
      } catch (err) {
        if (warm && leaf.isResetError?.(err)) {
          drain = await drainIdKeyedDelta(deltaDeps, leaf.coldStartRef(connection));
        } else {
          pagesByConn.set(connection.name, pageFetches); // charge fetches made before the throw
          throw err;
        }
      }
      pagesByConn.set(connection.name, pageFetches);

      // Deletes FIRST (independent of the upserts by the last-wins split), and ONLY
      // on a drained walk — an undrained walk's tombstones are untrustworthy
      // (`shapeDeltaOutcome`'s suppression rule). Idempotent: `tombstone` is a no-op
      // on an already-tombstoned / absent row, so a budget-yielded re-walk is safe.
      if (drain.drained) {
        for (const nativeId of drain.removedKeys) {
          engagementStore.tombstone({
            connection_id: connection.name,
            target_id: leaf.composeTargetId(nativeId),
            deleted_at: now(),
            actor: tombstoneActor,
            vendor_event_id: `${vendor}:delta:${nativeId}`,
          });
        }
        // The new terminal watermark to persist once the harness finishes ingest.
        // `watermark` is present iff drained; stash it (null-guarded).
        watermarkByConn.set(connection.name, drain.watermark ?? null);
      } else {
        // Undrained (malformed final page) — hold the prior token: `takeWatermark`
        // returns null → the harness re-walks from the same ref next cycle.
        watermarkByConn.set(connection.name, null);
      }

      // Upserts — yield each raw record; the harness runs `selfIngest` per record
      // (per-record budget yield applies), which re-projects from `_raw`.
      const polledAt = now();
      for (const raw of drain.rows) {
        const nativeId = leaf.readNativeId(raw);
        if (nativeId === null) continue; // unkeyable file — no target_id, skip
        yield {
          id: leaf.composeTargetId(nativeId),
          modified_at: leaf.readModifiedAt(raw) || polledAt,
          _raw: raw,
        };
      }
    },
    selfIngest(
      _connection: ConnectionRecord,
      connection_name: string,
      record: SlimRecord,
    ): void {
      // The harness only ever feeds back what `listUpdatedSince` yielded, so the
      // cast to the concrete slim is sound (mirrors the Salesforce reconcilers).
      const slim = record as GenericEngagementSlimRecord;
      const at = now();
      const meta = projectFlatMeta(slim._raw, entity);
      const row = leaf.project({
        connection_id: connection_name,
        raw: slim._raw,
        target_id: slim.id,
        meta,
        now: at,
      });
      const edges = leaf.mapEdges({
        connection_id: connection_name,
        raw: slim._raw,
        target_id: slim.id,
        now: at,
      });
      engagementStore.ingestEngagementWithEdges({ row, edges, now: at });
    },
    apiCallsFor(_processed: number, pages: number, connection_name?: string): number {
      // The true API cost is the number of delta pages fetched (a page of pure
      // tombstones processes 0 records but still costs one fetch, so the harness's
      // `ceil(processed/batch)` estimate `pages` badly undercounts). Fall back to
      // the estimate when the per-connection fetch count is unavailable.
      const fetched = connection_name !== undefined ? pagesByConn.get(connection_name) : undefined;
      return Math.max(pages, fetched ?? 0);
    },
  };
};
