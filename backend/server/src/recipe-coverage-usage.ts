/** D-247 D13 + D11 — the READ side of the coverage ledger.
 *
 *  ⛔⛔ THIS MODULE EXISTS BECAUSE THE FIELD MUST NOT SHIP WITHOUT ITS CONSUMER,
 *  AND THAT RULE IS THIS SPEC'S OWN SUBJECT MATTER. D-247 exists partly because
 *  `buildRecipeOpDependencyIndex` was written, tested, and called by NOTHING for
 *  long enough that the gap it covers became a shipped defect. A capture-only
 *  ledger would be the same artefact.
 *
 *  ## The two halves answer different questions, and the row needs both
 *
 *  - `buildRecipeOpDependencyIndex` is STATIC — which recipes COULD reach this
 *    op, derived from bodies.
 *  - This is ACTUAL — which runs DID, and under whose coverage.
 *
 *  A row showing only the first cannot tell a recipe that ran this morning from
 *  one that has not run since it was installed, which is most of what an owner
 *  deciding on a revoke wants to know.
 *
 *  ## ⛔ THE WINDOW IS PART OF THE ANSWER, NOT A DETAIL
 *
 *  `data.audit` is quota'd and evicts oldest-first, so "ran 0×" means NOT IN THE
 *  RETAINED WINDOW — never "never used". The caller is handed `window_days` back
 *  precisely so its copy cannot claim otherwise. An absence the owner reads as
 *  proof is the failure mode this substrate names repeatedly. */

import type { AuditLogStore } from '@recued/storage';

/** Per-op usage, for one bounded window. */
export interface RecipeCoverageUsage {
  /** How many dispatches this op reached ONLY because a recipe covered it. */
  readonly count: number;
  /** The covering recipes, by wire name, in first-seen order. */
  readonly recipes: readonly string[];
}

export interface RecipeCoverageUsageResult {
  /** operation_id → usage. Ops with no coverage-admitted run are ABSENT rather
   *  than zero, so a caller cannot accidentally render a confident zero for an
   *  op the ledger simply never mentioned. */
  readonly byOperation: ReadonlyMap<string, RecipeCoverageUsage>;
  /** The window the counts describe. Hand this to the copy; see the header. */
  readonly window_days: number;
  /** The oldest row actually scanned, epoch-ms, or null when none was found.
   *  ⚠ When this is NEWER than the window start, retention — not inactivity —
   *  bounded the answer, and the copy must say "in the retained window". */
  readonly oldest_scanned_at: number | null;
}

const COVERAGE_ACTION = 'recipe_coverage_admission';

/** Aggregate the coverage ledger by op over a bounded window.
 *
 *  ⚠ ONE query per RENDER, never per row: D11's grant matrix would otherwise ask
 *  this once per cell. The caller renders many ops from one result. */
export const readRecipeCoverageUsage = async (
  auditLog: Pick<AuditLogStore, 'listActivities'>,
  opts: { window_days: number; now: () => number; scan_limit?: number },
): Promise<RecipeCoverageUsageResult> => {
  const since = opts.now() - opts.window_days * 24 * 60 * 60 * 1000;
  const rows = await auditLog.listActivities(opts.scan_limit ?? 5_000);
  const byOperation = new Map<string, { count: number; recipes: string[] }>();
  let oldest: number | null = null;

  for (const row of rows) {
    if (row.action !== COVERAGE_ACTION) continue;
    if (typeof row.timestamp !== 'number') continue;
    oldest = oldest === null ? row.timestamp : Math.min(oldest, row.timestamp);
    if (row.timestamp < since) continue;
    const op = row.target;
    if (typeof op !== 'string' || op.length === 0) continue;
    let bucket = byOperation.get(op);
    if (!bucket) {
      bucket = { count: 0, recipes: [] };
      byOperation.set(op, bucket);
    }
    bucket.count += 1;
    // Fail-SOFT on a malformed detail: the COUNT is the load-bearing half and a
    // row whose JSON we cannot read still happened. Dropping it would understate
    // usage, which is the direction that reads as "safe to revoke".
    let granting: unknown;
    try {
      granting = row.detail === undefined
        ? undefined
        : (JSON.parse(row.detail) as { granting_recipe?: unknown }).granting_recipe;
    } catch { granting = undefined; }
    if (typeof granting === 'string' && granting.length > 0 && !bucket.recipes.includes(granting)) {
      bucket.recipes.push(granting);
    }
  }

  return {
    byOperation: new Map(
      [...byOperation].map(([op, b]) => [op, { count: b.count, recipes: b.recipes }]),
    ),
    window_days: opts.window_days,
    oldest_scanned_at: oldest,
  };
};
