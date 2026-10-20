/** D-325 §15.4 — the owner's coded answer to something Recued put in a cluster.
 * It shapes the proactive surfaces (Today and the pushed brief) only: the facts
 * stay readable by a granted AI, because a dismissal answers an interruption. */
import type Database from 'better-sqlite3';
import type { SituationDismissal, SituationItem, SituationRef } from '@recued/contracts';

export interface SituationDismissalRow {
  key: string;
  scope: 'item' | 'kind';
  code: Exclude<SituationDismissal, 'wrong'>;
  /** What the owner saw, so the restore list names it. */
  label: string;
  ref: SituationRef | null;
  kind: string;
  /** "Not now" lapses at the owner's next midnight; the others hold until restored. */
  until: number | null;
  at: number;
}
export const situationItemKey = (ref: SituationRef): string => `item:${JSON.stringify([ref.collection, ref.id, ref.field ?? null])}`;
export const situationKindKey = (kind: string): string => `kind:${kind}`;

export const createSituationDismissalStore = (db: Database.Database) => {
  db.exec(`CREATE TABLE IF NOT EXISTS situation_dismissals (
    key TEXT PRIMARY KEY, scope TEXT NOT NULL, code TEXT NOT NULL, label TEXT NOT NULL,
    ref TEXT, kind TEXT NOT NULL, until INTEGER, at INTEGER NOT NULL)`);
  type Row = Omit<SituationDismissalRow, 'ref'> & { ref: string | null };
  const read = (row: Row): SituationDismissalRow => ({ ...row, ref: row.ref ? JSON.parse(row.ref) as SituationRef : null });
  return {
    dismiss(row: SituationDismissalRow): void {
      db.prepare(`INSERT INTO situation_dismissals(key,scope,code,label,ref,kind,until,at) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(key) DO UPDATE SET scope=excluded.scope,code=excluded.code,label=excluded.label,ref=excluded.ref,kind=excluded.kind,until=excluded.until,at=excluded.at`)
        .run(row.key, row.scope, row.code, row.label, row.ref ? JSON.stringify(row.ref) : null, row.kind, row.until, row.at);
    },
    restore(key: string): boolean { return db.prepare('DELETE FROM situation_dismissals WHERE key=?').run(key).changes > 0; },
    /** Live dismissals, newest first; a lapsed "not now" is gone. */
    list(at: number): SituationDismissalRow[] {
      return (db.prepare('SELECT * FROM situation_dismissals WHERE until IS NULL OR until>? ORDER BY at DESC, key').all(at) as Row[]).map(read);
    },
    hides(item: Pick<SituationItem, 'ref' | 'kind'>, at: number): boolean {
      return db.prepare('SELECT 1 FROM situation_dismissals WHERE key IN (?,?) AND (until IS NULL OR until>?)')
        .get(situationItemKey(item.ref), situationKindKey(item.kind), at) !== undefined;
    },
  };
};
export type SituationDismissalStore = ReturnType<typeof createSituationDismissalStore>;
