/** D-123 Phase 3 — `link-discovery` housekeeping task.
 *
 *  Walks the provenance `links` table (D-120 Phase 1 — distinct
 *  from the D-119 Phase 13 typed-relationship `link` table) and
 *  counts `(entity_id, kind)` pairs over a rolling 30-day window.
 *  When a pair clears `LINK_DISCOVERY_THRESHOLD`, the task upserts
 *  one annotation against the underlying entity surfacing the
 *  pattern — Memory's "frequent touch" signal.
 *
 *  Schema-fit deviation from spec §3.3 (handover note 2026-04-29):
 *  the spec emits link rows of kind `frequent_correspondent` /
 *  `frequent_collaborator`, but those values are not in the
 *  `LINK_KINDS` taxonomy (which is `execution.action` /
 *  `execution.derived` / `execution.write` only — see
 *  `packages/contracts/src/links.ts`). Annotations against the
 *  entity carry the same signal in the schema-allowed shape: the
 *  Memory tab's per-record annotation panel + the existing
 *  `annotation-list` ingredient surface them through the read
 *  paths recipes already use.
 *
 *  Provenance entity_id format is `<collection>:<entity_id>`
 *  (set in `backend/server/src/memory-links.ts:71`); the task
 *  splits on the first colon to derive the annotation's
 *  `target_collection` + `target_id`.
 *
 *  Cursor: `{ kind: 'complete' }` — every step re-aggregates the
 *  rolling 30-day window from scratch. Aggregation is cheap and
 *  the window slides forward on every cycle, so persisting an
 *  intermediate cursor would just produce stale state.
 *
 *  No `onInvalidate` — the rolling window absorbs source-record
 *  deletes naturally; the annotation we wrote against a deleted
 *  entity is reaped by `cascadeDelete` on the parent record's
 *  delete (D-119 Phase 13 contract).
 *
 *  Spec: D-123 §3.3. */

import type {
  HousekeepingCursor,
  HousekeepingStepResult,
  LinkKind,
} from '@recued/contracts';

import type {
  HousekeepingContext,
  HousekeepingTaskInstance,
} from '../registry.js';

/** Rolling window the aggregation considers. Thirty days matches
 *  the spec text and gives enough samples for tick-noisy reactive
 *  recipes to clear the threshold without registering one-shot
 *  cron fires as patterns. */
export const LINK_DISCOVERY_WINDOW_MS = 30 * 24 * 60 * 60_000;

/** Per-`(entity_id, kind)` count required before the task emits a
 *  pattern annotation. Five matches the spec's "≥5 mail exchanges"
 *  example and aligns with the user-perceptible "this entity is
 *  recurring in my workflow" signal. */
export const LINK_DISCOVERY_THRESHOLD = 5;

/** `authored_by_recipe_id` stamp on every annotation the task
 *  writes — distinguishes housekeeping-emitted rows from
 *  recipe-emitted ones in the Memory tab + audit feeds. The
 *  matching prefix (`system.housekeeping.*`) is the convention
 *  P4's enrichment producer harness will use too. */
export const LINK_DISCOVERY_AUTHORED_BY = 'system.housekeeping.link-discovery';

/** Annotation key on the target entity. Stable across runs so
 *  consumers can `annotation-list` against it. */
export const LINK_DISCOVERY_ANNOTATION_KEY = 'housekeeping.frequent_touch';

interface AggregateRow {
  entity_id: string;
  kind: LinkKind;
  c: number;
}

/** Split `<collection>:<id>` on the first colon. Returns null when
 *  the entity_id is malformed (no colon, empty parts) so the loop
 *  can skip without throwing. Matches the inverse of the
 *  `${link.collection}:${link.entity_id}` join in
 *  `memory-links.ts:71`. */
const splitEntityId = (
  entity_id: string,
): { collection: string; id: string } | null => {
  const idx = entity_id.indexOf(':');
  if (idx <= 0 || idx === entity_id.length - 1) return null;
  return {
    collection: entity_id.slice(0, idx),
    id: entity_id.slice(idx + 1),
  };
};

/** True iff the annotation table exists. Production wires it via
 *  `ensureAnnotationSchema(db)` at boot; absence means no D-119
 *  Phase 13 storage has been initialised yet, in which case the
 *  task is a no-op. */
const annotationTableExists = (ctx: HousekeepingContext): boolean =>
  (
    ctx.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='annotation'`,
      )
      .get() as { name: string } | undefined
  )?.name === 'annotation';

const linksTableExists = (ctx: HousekeepingContext): boolean =>
  (
    ctx.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='links'`,
      )
      .get() as { name: string } | undefined
  )?.name === 'links';

export const linkDiscoveryTask: HousekeepingTaskInstance = {
  meta: {
    id: 'link-discovery',
    description:
      'Surface frequent-touch entities by counting provenance (entity_id, kind) pairs over the rolling 30-day window.',
    interruptible: true,
    kind: 'core',
    tags: ['kind:core', 'domain:memory', 'surface:deterministic'],
  },

  async step(
    ctx: HousekeepingContext,
    _cursor: HousekeepingCursor,
    budget_ms: number,
  ): Promise<HousekeepingStepResult> {
    if (!linksTableExists(ctx) || !annotationTableExists(ctx)) {
      return { status: 'complete', cursor: { kind: 'complete' } };
    }

    const start = ctx.now();
    const window_start = start - LINK_DISCOVERY_WINDOW_MS;

    const rows = ctx.db
      .prepare(
        `SELECT entity_id, kind, COUNT(*) AS c
           FROM links
          WHERE ts >= ?
          GROUP BY entity_id, kind
         HAVING c >= ?
          ORDER BY entity_id ASC, kind ASC`,
      )
      .all(window_start, LINK_DISCOVERY_THRESHOLD) as AggregateRow[];

    if (rows.length === 0) {
      return { status: 'complete', cursor: { kind: 'complete' } };
    }

    const upsertStmt = ctx.db.prepare(`
      INSERT INTO annotation (
        id, target_collection, target_id, key,
        value_inline, blob_hash, size_bytes,
        authored_by_recipe_id, source_record_hash, recipe_hash, model_used,
        authored_at, event_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        value_inline = excluded.value_inline,
        size_bytes   = excluded.size_bytes,
        authored_at  = excluded.authored_at,
        source_record_hash = excluded.source_record_hash,
        recipe_hash  = excluded.recipe_hash
    `);

    const tx = ctx.db.transaction((aggregate: readonly AggregateRow[]) => {
      for (const row of aggregate) {
        const split = splitEntityId(row.entity_id);
        if (!split) continue;

        const value = {
          pattern: 'frequent_touch',
          kind: row.kind,
          count: row.c,
          window_days: 30,
          computed_at: ctx.now(),
        };
        const value_inline = JSON.stringify(value);
        const size_bytes = Buffer.byteLength(value_inline, 'utf8');

        // Deterministic id keeps re-emissions idempotent across
        // cycles — same entity + kind always lands on the same row.
        const annotation_id = `hk-link-discovery::${row.entity_id}::${row.kind}`;
        // `source_record_hash` carries the agg signature so a
        // count-change updates the row's auditable footprint.
        const source_record_hash = `${row.entity_id}|${row.kind}|${row.c}`;

        upsertStmt.run(
          annotation_id,
          split.collection,
          split.id,
          LINK_DISCOVERY_ANNOTATION_KEY,
          value_inline,
          size_bytes,
          LINK_DISCOVERY_AUTHORED_BY,
          source_record_hash,
          LINK_DISCOVERY_AUTHORED_BY,
          ctx.now(),
        );
      }
    });

    tx(rows);

    // Budget check after the upsert tx — link-discovery's read
    // path is one aggregate query so we never partially apply, but
    // the scheduler still expects a yield signal when budget runs
    // out so subsequent tasks in the same cycle get skipped cleanly.
    if (ctx.now() - start >= budget_ms) {
      return {
        status: 'yield',
        reason: 'budget_exhausted',
        cursor: { kind: 'complete' },
      };
    }
    return { status: 'complete', cursor: { kind: 'complete' } };
  },
};

// Exported for tests that want to seed deterministic annotation
// ids without re-deriving the format.
export const linkDiscoveryAnnotationId = (entity_id: string, kind: string): string =>
  `hk-link-discovery::${entity_id}::${kind}`;
