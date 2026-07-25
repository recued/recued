/** D-190 (generic reconciler MS4) — the GENERIC CRM reconciler.
 *
 *  A single `VendorReconciler` factory that mirrors ANY conformant CRM vendor —
 *  HubSpot/Salesforce have bespoke reconcilers (vendor-specific incremental
 *  filters + webhook acceleration), but Pipedrive / any pack-declared CRM
 *  (`crm_alias` entity + a declared `SearchStyle`) gets this one instead, with
 *  ZERO per-vendor code. It plugs into the SAME `buildVendorReconciliationTask`
 *  harness, so it writes the `crm_record_mirror` (MS2) exactly like hb/sf and
 *  joins the local-mirror `deal.search` union (MS3).
 *
 *  The three vendor-specific methods the harness needs all reduce to the
 *  canonical machinery D-190 already built:
 *
 *    - `listUpdatedSince` = ONE `runCanonicalWatchPoll` (the gated + audited
 *      canonical `<entity>.search`, full-walk projection) → yield each projected
 *      record as a SlimRecord. FULL WALK v1: the poll is match-all, so the
 *      cursor/limit are ignored and the harness hash-diff skips unchanged rows.
 *    - `toMeta` = the canonical projected record IS the meta (the poll ran the
 *      same projection a resolved recipe read would), stamped with the two
 *      reconciler fields. Vendor-NEUTRAL by construction — same `maps_to` keys
 *      the read side projects.
 *    - `hashOf` = generic FNV-1a over the canonical fields (deterministic,
 *      vendor-agnostic) so the harness short-circuits unchanged records.
 *
 *  `listDeletedSince` (S2) = a FULL-WALK DIFF computed inside `listUpdatedSince`
 *  (which already polls the set + reads the mirror's prior hashes): mirror rows for
 *  this connection absent from a poll the gateway PROVABLY walked to exhaustion
 *  (`outcome.complete` — pagination ran + not truncated; NOT merely `!truncated`,
 *  which a non-paginating first-page-only catalog also reports) are deleted.
 *  No 2nd poll, no new mirror method — reuses the poll + `getPriorHashes`.
 *
 *  v1 deferrals (flagged): no incremental cursor (full walk each cycle); no clamp on
 *  an over-large canonical field (the meta cap fails loud at the mirror upsert — the
 *  canonical CRM field set is bounded scalars, so this is a pack-config edge, not a
 *  routine path).
 *
 *  PER-CONNECTION SCOPING (D-128 follow-up, resolved) — the platform-reference
 *  scope stays per-VENDOR (`connection.api.<vendor>.<entity>`, shared across a
 *  vendor's connections), but the `target_id` is now connection-qualified via
 *  `composePlatformRecordTargetId` (`<vendor>_<entity>_<connection>_<native>`). Two
 *  connections of the SAME vendor draw native ids from disjoint portals/orgs that
 *  overlap heavily (HubSpot ids are portal-scoped sequential integers); the
 *  connection segment gives each its own id namespace, so the mirror + enrichment
 *  store (both keyed on `(scope, target_id)`) no longer collide AND this reconciler's
 *  per-scope self-filter can't ping-pong — connection A only ever looks up its own
 *  `<vendor>_<entity>_A_*` ids, never B's. The bespoke hb/sf reconcilers compose the
 *  SAME connection-qualified id (uniform). `deal.search` still unions per-vendor (v1);
 *  the rows are de-collided, so the union is correct. NOTE: the generic poll projects
 *  the RAW native id (`hs_object_id` / `Id` — the projection emits no prefix), so the
 *  `<vendor>_<entity>_` prefix is added HERE, which also makes generic records
 *  consistent with bespoke + dispatchable by the cross-vendor `data.crm.*` resolver.
 *
 *  Spec: internal design notes (MS4). */

import {
  composePlatformRecordTargetId,
  composeVendorEntityScope,
  type ConnectionRecord,
  type EnrichmentMeta,
  type EnrichmentScope,
} from '@recued/contracts';

import type {
  ReconciliationCadence,
  SlimRecord,
  VendorReconciler,
} from '../housekeeping/reconciliation/vendor-reconciler.js';
import {
  runCanonicalWatchPoll,
  type CanonicalPollDeps,
  type CanonicalPollOutcome,
} from '../watch/canonical-poll.js';
import { canonicalFields, hashCanonical, stableStringify } from '../source-mirror/hash.js';
import { computeCompleteWalkDeletes } from '../source-mirror/diff.js';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/** SlimRecord variant carrying the canonical projected record (from the poll).
 *  The harness reads only `id` + `modified_at`; `hashOf` + `toMeta` consume
 *  `_record` — the SAME canonical projection the read side (`projectPlatformDeal`)
 *  surfaces. */
export interface CanonicalCrmSlimRecord extends SlimRecord {
  _record: Record<string, unknown>;
}

/** Poll runner shape — `runCanonicalWatchPoll`. Injected as a test seam so the
 *  reconciler is unit-testable without standing up the gateway/executor. */
export type CanonicalPollRunner = (
  deps: CanonicalPollDeps,
  input: { vendor: string; entity: string; connection_name: string },
) => Promise<CanonicalPollOutcome>;

export interface BuildCanonicalCrmReconcilerInput {
  /** Vendor segment of the platform-reference scope (`pipedrive`, …). */
  vendor: string;
  /** Entity segment (`deal`, `contact`, `account`, …). */
  entity: string;
  /** Canonical poll deps — `executorConfig` / `profiles` / `audit` /
   *  `contractScan` / the live vendor registry. Injected at construction (boot),
   *  where the watch-manager already assembles them. */
  pollDeps: CanonicalPollDeps;
  /** Prior mirror snapshot hashes for a scope (`mirror.listSnapshotHashes`).
   *  THE incremental seam: the canonical poll is match-all (full walk), so without
   *  this the harness would re-emit a warehouse event (firing cascades + AI
   *  producers + audit) for EVERY record EVERY cycle — un-enriched records have no
   *  enrichment row, so the harness's enrichment hash-diff never short-circuits
   *  them. Comparing each polled record's hash against its mirror row's stored hash
   *  turns the full walk into an incremental sync: a cold mirror yields everything
   *  once (backfill), then only new / changed records reach the harness. */
  getPriorHashes: (scope: EnrichmentScope) => Map<string, string>;
  /** Wall-clock used for the per-cycle `modified_at` + `meta.snapshot_at`.
   *  Defaults to `Date.now`; tests pin it. */
  now?: () => number;
  /** Default polling cadence. Defaults to `'6h'` (the conservative CRM cadence). */
  cadence?: ReconciliationCadence;
  /** Test seam — substitute the poll runner. Production omits it (the real
   *  `runCanonicalWatchPoll`). */
  runPoll?: CanonicalPollRunner;
}

// ────────────────────────────────────────────────────────────────
// Hashing — the shared source-mirror convention (D-192 P1.5: lifted to
// `../source-mirror/hash.js`; re-exported here for existing importers).
// ────────────────────────────────────────────────────────────────

export { stableStringify };

// ────────────────────────────────────────────────────────────────
// Factory
// ────────────────────────────────────────────────────────────────

/** Build a generic `VendorReconciler` for `(vendor, entity)` backed by the
 *  canonical poll. Carries `hashOf` + `toMeta` (NOT `selfIngest`) so the harness
 *  drives the default mirror-writing path. */
export const buildCanonicalCrmReconciler = (
  input: BuildCanonicalCrmReconcilerInput,
): VendorReconciler => {
  const { vendor, entity, pollDeps, getPriorHashes } = input;
  const now = input.now ?? ((): number => Date.now());
  const runPoll = input.runPoll ?? runCanonicalWatchPoll;
  const default_cadence: ReconciliationCadence = input.cadence ?? '6h';
  const scope: EnrichmentScope = composeVendorEntityScope(vendor, entity);

  // S2 (delete detection) — per-connection delete list, computed during the full-walk
  // `listUpdatedSince` (which already polls the COMPLETE set + reads the mirror's prior
  // hashes) and drained by `listDeletedSince` in the SAME harness step (the harness
  // calls update→delete sequentially per connection). Keyed by connection_name so
  // concurrent steps for DIFFERENT connections never cross; cleared at the start of
  // each `listUpdatedSince` so a budget-suspended generator leaves no stale list
  // (fail-safe: a missing entry → zero deletes, never a false delete).
  const pendingDeletes = new Map<string, string[]>();

  return {
    vendor,
    entity,
    default_cadence,
    async *listUpdatedSince(
      connection: ConnectionRecord,
      _cursor: number,
      _limit: number,
    ): AsyncIterable<CanonicalCrmSlimRecord> {
      // S2 — start a fresh delete computation for this connection. If the harness
      // suspends this generator for budget BEFORE the diff below runs, the stash stays
      // empty → `listDeletedSince` yields nothing (no false delete from a partial walk).
      pendingDeletes.delete(connection.name);
      // FULL walk v1 — the canonical poll is match-all (it ignores cursor/limit).
      // Incremental seam: read the mirror's prior hashes up front + skip a record
      // whose canonical hash already matches, so only new / changed records reach
      // the harness (a cold mirror yields everything once, then converges).
      const priorHashes = getPriorHashes(scope);
      const outcome = await runPoll(pollDeps, {
        vendor,
        entity,
        connection_name: connection.name,
      });
      if (!outcome.ok) {
        // A failed poll (config / policy / error / unavailable) yields NOTHING
        // this cycle: the poll's own `onGatewayAudit` records the failure and the
        // harness completes with no work, retrying next idle window. (A throw
        // would abort the whole housekeeping step; a fetch failure is a
        // skip-this-cycle condition, not a step error.)
        return;
      }
      // One timestamp for the whole cycle's records. For a full walk the cursor
      // is cosmetic (the next cycle re-walks regardless); `modified_at` is NOT
      // part of `hashOf`, so this never perturbs the skip-on-match.
      const polledAt = now();
      const polledIds = new Set<string>();
      for (const [nativeId, record] of outcome.records) {
        // Qualify the poll's RAW native id by connection so two connections of the
        // same vendor get disjoint target_id namespaces — de-colliding the mirror /
        // enrichment store AND making the per-scope self-filter connection-safe (the
        // prior hashes for OTHER connections' ids can never match this one's). The
        // `<vendor>_<entity>_` prefix is added here (the projection emits none),
        // matching the bespoke hb/sf reconcilers.
        const target_id = composePlatformRecordTargetId(vendor, entity, connection.name, nativeId);
        polledIds.add(target_id); // the COMPLETE current set (incl. unchanged) for the delete diff
        if (priorHashes.get(target_id) === hashCanonical(record)) continue; // unchanged — skip
        yield { id: target_id, modified_at: polledAt, _record: record };
      }
      // S2 delete detection (full-walk diff) — `computeCompleteWalkDeletes`
      // (the shared source-mirror correctness home, D-192 P1.5) gates on
      // `outcome.complete`, NOT `!truncated` (a non-paginating catalog's
      // first page reports `truncated:false` without proving completeness —
      // fail-closed: not complete ⇒ zero deletes this cycle, catch up once
      // pagination is configured / the walk finishes). `getPriorHashes`
      // already gave us the mirror's target_ids for the scope (ALL
      // connections); the prefix restricts the diff to THIS connection —
      // `<vendor>_<entity>_<connection>_`, whose trailing `_` is an
      // unambiguous boundary since connection names exclude `_` (so `acme_`
      // can't false-match `acme-corp_`). The harness drops each yielded id's
      // mirror row + emits its `deleted` event (→ cascade invalidation).
      // Stash only on a complete walk — a missing entry means "no proof",
      // never "no deletes".
      if (outcome.complete) {
        pendingDeletes.set(connection.name, computeCompleteWalkDeletes({
          complete: outcome.complete,
          priorKeys: priorHashes.keys(),
          polledKeys: polledIds,
          keyPrefix: `${vendor}_${entity}_${connection.name}_`,
        }));
      }
    },
    async *listDeletedSince(
      connection: ConnectionRecord,
      _cursor: number,
    ): AsyncIterable<string> {
      // S2 — drain the delete list `listUpdatedSince` computed for THIS connection in
      // the same step. Clear on read so a later cycle whose `listUpdatedSince` yields
      // nothing (or is suspended) can never replay a stale list.
      const deletes = pendingDeletes.get(connection.name) ?? [];
      pendingDeletes.delete(connection.name);
      for (const target_id of deletes) yield target_id;
    },
    hashOf(record: CanonicalCrmSlimRecord): string {
      return hashCanonical(record._record);
    },
    toMeta(record: CanonicalCrmSlimRecord): EnrichmentMeta {
      // The canonical projected record IS the meta — the poll already ran the
      // same `maps_to` projection the read side uses, so the mirror `meta` is
      // vendor-neutral by construction. Drop the identity key (the mirror's
      // `target_id` already carries it) and stamp the two reconciler fields LAST —
      // so a pack CRM that projects a canonical field named `snapshot_at` /
      // `snapshot_hash` (non-canonical `maps_to` is an install warning, not a
      // block) can NEVER shadow the reconciler's computed values, which the
      // self-filter + the harness skip-on-match both depend on.
      return {
        ...canonicalFields(record._record),
        snapshot_at: now(),
        snapshot_hash: hashCanonical(record._record),
      };
    },
  };
};
