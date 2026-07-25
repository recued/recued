/** D-116 follow-up — CLI `recued-server status` auto-disabled
 *  read-out.
 *
 *  Reads SQLite directly so the command works whether or not the
 *  daemon is running — the persisted circuit-breaker state is the
 *  truth either way (a restart hydrates back from this same table).
 *  The HTTP `/status` mirror exposes the same data via the live
 *  scheduler roster; both routes share the projection contract from
 *  `@recued/scheduler`.
 *
 *  process_id and last_finished_at are deliberately omitted — they're
 *  in-memory state on the live scheduler, not persisted on the
 *  circuit row. CLI users care about the failure count + reason +
 *  recipe identity, not transient runtime ids.
 */

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import type { RecipeDefinition } from '@recued/contracts';

export interface AutoDisabledRow {
  recipe_id: string;
  publisher_id: string;
  /** Resolved from `recipes.recipe_json -> metadata.name`. Falls back
   *  to recipe_id when the recipe row is missing (e.g. uninstalled
   *  but the circuit row hasn't been cleared yet — possible if the
   *  uninstaller missed the cleanup step). */
  name: string;
  consecutive_failures: number;
  /** Epoch ms; null when no failure has been recorded. */
  last_failure_at: number | null;
  last_failure_reason: string | null;
}

const extractName = (recipe_json: string | null): string | null => {
  if (!recipe_json) return null;
  try {
    const recipe = JSON.parse(recipe_json) as RecipeDefinition;
    return recipe.metadata?.name ?? null;
  } catch {
    return null;
  }
};

/** Read every auto-disabled circuit row + project it into a UI row.
 *  Tolerates a missing DB / missing tables (returns []). */
export const readAutoDisabledFromDb = (dbPath: string): AutoDisabledRow[] => {
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='auto_run_circuit'")
      .get();
    if (!tableExists) return [];

    const rows = db
      .prepare(`
        SELECT
          c.recipe_id,
          c.consecutive_failures,
          c.last_failure_at,
          c.last_failure_reason,
          r.publisher_id,
          r.recipe_json
        FROM auto_run_circuit c
        LEFT JOIN recipes r ON r.recipe_id = c.recipe_id
        WHERE c.auto_disabled = 1
        ORDER BY c.recipe_id ASC
      `)
      .all() as Array<{
        recipe_id: string;
        consecutive_failures: number;
        last_failure_at: number | null;
        last_failure_reason: string | null;
        publisher_id: string | null;
        recipe_json: string | null;
      }>;

    return rows.map((row) => ({
      recipe_id: row.recipe_id,
      publisher_id: row.publisher_id ?? '',
      name: extractName(row.recipe_json) ?? row.recipe_id,
      consecutive_failures: row.consecutive_failures,
      last_failure_at: row.last_failure_at,
      last_failure_reason: row.last_failure_reason,
    }));
  } finally {
    db.close();
  }
};

/** Render the rows as a plain-text block for the CLI status output.
 *  Empty input → single-line "Auto-disabled: none" so the caller can
 *  splice the result unconditionally without a count check. */
export const renderAutoDisabledTable = (rows: readonly AutoDisabledRow[]): string => {
  if (rows.length === 0) return 'Auto-disabled: none';
  const lines: string[] = [
    `Auto-disabled: ${rows.length} recipe${rows.length === 1 ? '' : 's'}`,
    '',
  ];
  for (const r of rows) {
    const when = r.last_failure_at ? new Date(r.last_failure_at).toISOString() : 'never';
    const reason = r.last_failure_reason ?? '(no recorded reason)';
    lines.push(`  ${r.recipe_id}`);
    lines.push(`    name:      ${r.name}`);
    lines.push(`    publisher: ${r.publisher_id || '—'}`);
    lines.push(`    failures:  ${r.consecutive_failures}`);
    lines.push(`    last:      ${when}`);
    lines.push(`    reason:    ${reason}`);
    lines.push('');
  }
  lines.push('  Reset via: paired extension Options → Auto-disabled.');
  return lines.join('\n');
};
