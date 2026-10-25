/** Opt-in statement counters for disposable qualification realms. No SQL,
 * parameters, filenames or credentials enter a receipt. These are logical
 * statement callbacks and expanded-statement bytes, not physical disk I/O. */
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export type SqlMetricKind = 'select' | 'insert' | 'update' | 'delete' | 'pragma' | 'transaction' | 'ddl' | 'other';
export interface QualificationSqlMetrics {
  readonly version: 1;
  readonly statements: Record<SqlMetricKind, number>;
  readonly expanded_statement_bytes: Record<SqlMetricKind, number>;
}
export const emptySqlMetrics = (): QualificationSqlMetrics => ({ version: 1,
  statements: { select: 0, insert: 0, update: 0, delete: 0, pragma: 0, transaction: 0, ddl: 0, other: 0 },
  expanded_statement_bytes: { select: 0, insert: 0, update: 0, delete: 0, pragma: 0, transaction: 0, ddl: 0, other: 0 },
});
export const sqlMetricKind = (sql: string): SqlMetricKind => {
  const word = sql.replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/u, '').match(/^[a-z]+/iu)?.[0]?.toLowerCase();
  if (word === 'select' || word === 'insert' || word === 'update' || word === 'delete' || word === 'pragma') return word;
  if (word && ['begin', 'commit', 'rollback', 'savepoint', 'release'].includes(word)) return 'transaction';
  if (word && ['create', 'alter', 'drop', 'reindex', 'vacuum', 'analyze'].includes(word)) return 'ddl';
  // WITH may read or mutate. Keep it unknown instead of guessing its work.
  return 'other';
};

let active: ((sql: string) => void) | undefined;
/** Called only when an operator explicitly chooses a private output directory. */
export const qualificationSqlMetrics = (): ((sql: string) => void) | undefined => {
  const directory = process.env.RECUED_QUALIFICATION_SQL_METRICS_DIRECTORY;
  if (!directory) return undefined;
  if (active) return active;
  try { mkdirSync(directory, { recursive: true, mode: 0o700 }); }
  catch { return undefined; }
  const file = join(directory, `sql-${process.pid}.json`); const temporary = `${file}.tmp`;
  const metrics = emptySqlMetrics(); let queued = false;
  const flush = () => {
    queued = false;
    try { writeFileSync(temporary, JSON.stringify(metrics), { mode: 0o600 }); renameSync(temporary, file); }
    catch { /* Diagnostics cannot change a database operation's outcome. */ }
  };
  active = sql => {
    const kind = sqlMetricKind(sql); metrics.statements[kind]++; metrics.expanded_statement_bytes[kind] += Buffer.byteLength(sql, 'utf8');
    if (!queued) { queued = true; queueMicrotask(flush); }
  };
  return active;
};
