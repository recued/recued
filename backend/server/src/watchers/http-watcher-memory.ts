/** The page watcher's own memory of the page (`once_per_change`, 2026-10-05).
 *
 *  Without it, `http-watcher` compares a page against a hash the recipe passes
 *  in (`previous_hash`), so a recipe that fires once per change must store
 *  that hash itself, and the page it wants to compare against too. That store
 *  is a write. The Web Watch pack offers only "Read only" access, so every
 *  unattended run was held for approval at its cursor write (live drive,
 *  2026-10-05): the pack could not run on its own as shipped.
 *
 *  With `once_per_change: true` the server keeps one row per recipe and page
 *  address: the page as of the last change a completed run reported, and the
 *  page a fire reported, pending until that run settles. A check compares
 *  against the reported page and hands it to the recipe as `previous_body`,
 *  so the recipe compares the two and writes nothing.
 *
 *  ⛔ The memory moves on only when the run that reported a change COMPLETES
 *  (`settleHttpWatcherRun`, called where `execute-handler.ts` records the
 *  run). Moving it at the check would lose a change whenever the run failed
 *  after the fire, for instance when the model did not answer: the next check
 *  would find the page unchanged and never report it. That is what the
 *  recipes' own cursor did, written at the end of the run, and what a reactive
 *  cursor needs (CLAUDE.md, `context.recipe.*`: "written only once the
 *  expensive work completed"). A failed or skipped run drops its pending page,
 *  so the next check fires again; a run held for an answer keeps it, and its
 *  resume settles it under the same run id.
 *
 *  The recipe and the run are engine-owned: the kernel adapter writes both from
 *  the step's metadata (`RECIPE_KEYED_WATCHER_SLUGS`), so a recipe can neither
 *  read another recipe's stored page nor settle another run.
 *
 *  ⚠ Two dishes of one recipe watching the same address share one row (the
 *  engine passes no dish to a step). The recipe-written cursor this replaces
 *  was one key for the whole recipe, whatever the address. */

import type Database from 'better-sqlite3';
import {
  IngredientError,
  evaluateHttpWatcher,
  type HttpWatcherArgs,
  type HttpWatcherOutput,
} from '@recued/ingredients';

const TABLE = 'http_watcher_memory';

export interface HttpWatcherHandlerDeps {
  /** Holds the memory. Absent ⇒ `once_per_change` is unavailable. */
  db?: Database.Database;
  fetchFn?: typeof fetch;
  now?: () => number;
}

export interface HttpWatcherMemoryOutput extends HttpWatcherOutput {
  /** With `once_per_change`: the page as of the last change a completed run
   *  reported, `null` before the first. Absent without `once_per_change`. */
  previous_body?: string | null;
}

/** How a run that may have reported a change ended. */
export type HttpWatcherRunOutcome =
  /** It completed: the page it reported becomes the one to compare against. */
  | 'reported'
  /** It failed, was killed, or a later trigger step skipped it: the next check
   *  reports the change again. */
  | 'not_reported'
  /** It waits for an answer; its resume settles it under the same run id. */
  | 'waiting';

const ensured = new WeakSet<Database.Database>();

export const ensureHttpWatcherMemorySchema = (db: Database.Database): void => {
  if (ensured.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      recipe_id      TEXT NOT NULL,
      target_url     TEXT NOT NULL,
      hash           TEXT,
      body           TEXT,
      reported_at    INTEGER,
      pending_hash   TEXT,
      pending_body   TEXT,
      pending_run_id TEXT,
      pending_at     INTEGER,
      PRIMARY KEY (recipe_id, target_url)
    );

    CREATE INDEX IF NOT EXISTS idx_http_watcher_memory_pending
      ON ${TABLE} (pending_run_id);
  `);
  ensured.add(db);
};

const invalid = (message: string, details: Record<string, unknown> = {}): IngredientError =>
  new IngredientError('TRANSFORM_INVALID_INPUT', `http-watcher: ${message}`, { slug: 'http-watcher', ...details });

const engineId = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

export const handleHttpWatcher = async (
  deps: HttpWatcherHandlerDeps,
  args: Record<string, unknown>,
): Promise<HttpWatcherMemoryOutput> => {
  const { once_per_change: once, recipe_id, run_id, ...fetchArgs } = args;
  const fetchDeps = deps.fetchFn ? { fetchFn: deps.fetchFn } : {};
  if (once !== undefined && typeof once !== 'boolean') {
    throw invalid(`once_per_change must be true or false (got ${JSON.stringify(once)})`);
  }
  if (once !== true) return evaluateHttpWatcher(fetchArgs as unknown as HttpWatcherArgs, fetchDeps);

  if (fetchArgs.previous_etag !== undefined || fetchArgs.previous_hash !== undefined) {
    throw invalid('once_per_change keeps its own memory of the page; leave out previous_etag and previous_hash');
  }
  const recipe = engineId(recipe_id);
  const run = engineId(run_id);
  if (recipe === undefined || run === undefined) {
    throw invalid('once_per_change remembers the page for the recipe it runs in, so it works only as a step of a recipe run');
  }
  const target_url = fetchArgs.target_url;
  if (typeof target_url !== 'string' || target_url.length === 0) {
    throw invalid('target_url must be a non-empty string', { got: target_url });
  }
  if (deps.db === undefined) {
    throw new IngredientError(
      'SERVER_NOT_REACHABLE',
      'http-watcher once_per_change unavailable — sqlite handle not configured on this server',
      { slug: 'http-watcher' },
    );
  }
  const db = deps.db;
  ensureHttpWatcherMemorySchema(db);

  const reported = db.prepare(
    `SELECT hash, body FROM ${TABLE} WHERE recipe_id = ? AND target_url = ?`,
  ).get(recipe, target_url) as { hash: string | null; body: string | null } | undefined;
  const out = await evaluateHttpWatcher(
    { target_url, ...(reported?.hash ? { previous_hash: reported.hash } : {}) },
    fetchDeps,
  );
  if (out.should_run) {
    db.prepare(
      `INSERT INTO ${TABLE} (recipe_id, target_url, pending_hash, pending_body, pending_run_id, pending_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (recipe_id, target_url) DO UPDATE SET
           pending_hash = excluded.pending_hash,
           pending_body = excluded.pending_body,
           pending_run_id = excluded.pending_run_id,
           pending_at = excluded.pending_at`,
    ).run(recipe, target_url, out.hash, out.body, run, (deps.now ?? Date.now)());
  }
  return { ...out, previous_body: reported?.body ?? null };
};

/** How a run that ended with `status` (the status its record carries) settles
 *  the page it reported. A run a later trigger step skipped reported nothing. */
export const httpWatcherRunOutcome = (status: string, trigger_skipped: boolean): HttpWatcherRunOutcome =>
  status === 'awaiting_approval' || status === 'awaiting_peer' ? 'waiting'
    : status === 'succeeded' && !trigger_skipped ? 'reported'
      : 'not_reported';

/** Settle the page a run reported, by how the run ended (see the header). */
export const settleHttpWatcherRun = (
  db: Database.Database,
  run_id: string,
  outcome: HttpWatcherRunOutcome,
  now: number = Date.now(),
): void => {
  if (outcome === 'waiting') return;
  ensureHttpWatcherMemorySchema(db);
  if (outcome === 'reported') {
    db.prepare(
      `UPDATE ${TABLE} SET hash = pending_hash, body = pending_body, reported_at = ?,
         pending_hash = NULL, pending_body = NULL, pending_run_id = NULL, pending_at = NULL
       WHERE pending_run_id = ?`,
    ).run(now, run_id);
    return;
  }
  db.prepare(
    `UPDATE ${TABLE} SET pending_hash = NULL, pending_body = NULL, pending_run_id = NULL, pending_at = NULL
     WHERE pending_run_id = ?`,
  ).run(run_id);
};

/** Drop what a recipe's page watchers remember. Run when the recipe is
 *  uninstalled (`recipe-owned-state.ts`): a reinstall starts from a first check. */
export const forgetHttpWatcherRecipe = (db: Database.Database, recipe_id: string): void => {
  ensureHttpWatcherMemorySchema(db);
  db.prepare(`DELETE FROM ${TABLE} WHERE recipe_id = ?`).run(recipe_id);
};
