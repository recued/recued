/** D-120 Phase 3 — server-side link persistence helper.
 *
 *  Engine-emitted `EmittedLink`s buffered during a run get written
 *  to the `links` SQLite table after the audit row's `run_id`
 *  (memory_id) is known. This module owns the bulk-insert path.
 *
 *  Insert is idempotent at the row level via the composite PK
 *  `(memory_id, entity_id, kind, ts)` — `INSERT OR IGNORE` so a
 *  retried emission within the same run / millisecond doesn't fail
 *  the bulk write. Per-run dedupe (engine-side) already covers the
 *  common case; this is belt-and-suspenders for transport retries.
 *
 *  Spec: docs/d-120-spec.md (Phase 3).
 */

import type Database from 'better-sqlite3';
import { SYSTEM_ORIGIN } from '@recued/contracts';
import type { EmittedLink, OriginProvenance } from '@recued/contracts';

/** What `insertLinks` needs from the run identity layer. The engine
 *  emits `EmittedLink`s without knowing the audit row's `run_id` or
 *  `recipe_insight_id` — both are fixed by the caller before bulk
 *  insert. */
export interface LinkInsertContext {
  /** Audit row's `run_id` (= memory_id). The engine emits one
   *  `EmittedLink` per touch; the caller fans these onto a single
   *  memory_id. */
  memory_id: string;
  /** Surrogate id from `recipe_insights` (Phase 1 + 2). Resolved
   *  via `ensureRecipeInsightId` before execution starts so links
   *  can land their FK. */
  recipe_insight_id: number;
  /** D-161 P1 — origin provenance facet for this run's emitted links.
   *  Run-level by construction (one `ExecutionSource` per run), so it
   *  rides the per-run insert context rather than each `EmittedLink`.
   *  The caller derives it once from the run's source
   *  (`originProvenanceFromOptionalSource(executionSource)` →
   *  `SYSTEM_ORIGIN` for sync/housekeeping runs). Stamped verbatim on
   *  every link row this run emits (I-5 / I-6). Optional — absent
   *  defaults to `SYSTEM_ORIGIN` (the conservative engine-internal
   *  origin), so a caller that omits it still writes a non-null
   *  `origin_actor`. */
  origin?: OriginProvenance;
}

/** Bulk-insert the buffered emissions for one run. Skips silently
 *  when there are no links (most common path: read-only recipes,
 *  recipes with `provenance: false`, or extensions without a
 *  link sink). Wrapped in a single SQLite transaction so a per-row
 *  failure rolls everything back rather than leaving a partial
 *  graph.
 *
 *  Persisted `entity_id` is the colon-delimited
 *  `<collection>:<entity_id>` form (D-120 Phase 5 wire shape — same
 *  format `parseTimelineEntityId` parses on the MCP boundary). The
 *  engine emits collection + entity_id separately so the classifier
 *  can read both; this insert path joins them at the storage edge so
 *  cross-collection ID collisions (e.g. `deal:42` vs `contact:42`)
 *  stay distinct rows. */
export const insertLinks = (
  db: Database.Database,
  ctx: LinkInsertContext,
  links: readonly EmittedLink[],
): number => {
  if (links.length === 0) return 0;
  // D-120 Phase 7.5 — `event_at` is bistemporal; null when the step
  // didn't carry an event date. The Phase 7.5 migration already
  // ALTER'd the column in (`ensureBistemporalSchema`), so the wider
  // INSERT is safe on every db that's seen the migration. Pre-7.5
  // boots that haven't run the migration would fail this INSERT — but
  // bin.ts always runs ensureBistemporalSchema before starting the
  // engine, so the column is present whenever this function runs.
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO links
       (memory_id, entity_id, recipe_insight_id, kind, ts, event_at,
        origin_actor, origin_contract_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // D-161 P1 — run-level origin facet, stamped on every link row this
  // run emits. Resolved once on the context (propagated from the run's
  // ExecutionSource, never re-derived — I-6); absent defaults to
  // SYSTEM_ORIGIN so the column is never null.
  const origin = ctx.origin ?? SYSTEM_ORIGIN;
  const originActor = origin.origin_actor;
  const originContractId = origin.origin_contract_id ?? null;
  const tx = db.transaction((rows: readonly EmittedLink[]) => {
    let inserted = 0;
    for (const link of rows) {
      const result = stmt.run(
        ctx.memory_id,
        `${link.collection}:${link.entity_id}`,
        ctx.recipe_insight_id,
        link.kind,
        link.ts,
        link.event_at ?? null,
        originActor,
        originContractId,
      );
      if (result.changes > 0) inserted += 1;
    }
    return inserted;
  });
  return tx(links);
};
