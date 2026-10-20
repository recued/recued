import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { SituationPlace, SituationRef, SituationWindow, Sphere } from '@recued/contracts';

/** A minimal candidate copied before raw mail retention, never a mailbox,
 * full message, document body, automatically retained episode or lifelog. */
export interface ProactiveTrace {
  id: string;
  title: string;
  when: SituationWindow;
  where?: SituationPlace;
  people: string[];
  subjects: SituationRef[];
  sources: SituationRef[];
  class_id: 'flowers' | 'gifts' | 'restaurants' | 'activity' | 'photos' | 'checkin';
  sphere?: Sphere;
  observed_at: number;
  retained_at?: number;
  source_mailbox?: string;
}
export const traceId = (ref: SituationRef, item: string): string => `trace-${createHash('sha256').update(JSON.stringify([ref.collection, ref.id, item])).digest('hex')}`;
/** Yours shows the latest capture receipts; no older one is kept. */
export const CAPTURE_RECEIPTS_KEPT = 100;
const RECEIPT_ORDER = 'ORDER BY at DESC,mailbox,cutoff DESC';
export const createProactiveTraceStore = (db: Database.Database) => {
  db.exec(`CREATE TABLE IF NOT EXISTS proactive_retained_traces (id TEXT PRIMARY KEY,mailbox TEXT NOT NULL,at INTEGER NOT NULL,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS proactive_history_capture_receipts (mailbox TEXT NOT NULL,cutoff INTEGER NOT NULL,at INTEGER NOT NULL,candidates INTEGER NOT NULL,PRIMARY KEY(mailbox,cutoff));`);
  return {
    get(id: string): ProactiveTrace | null {
      const row = db.prepare('SELECT value FROM proactive_retained_traces WHERE id=?').get(id) as { value: string } | undefined;
      return row ? JSON.parse(row.value) : null;
    },
    save(trace: ProactiveTrace, at: number): void {
      if (!trace.source_mailbox || !['flowers', 'gifts', 'restaurants', 'checkin'].includes(trace.class_id) || trace.title.length > 1000
        || trace.when.from > trace.when.to || trace.when.to > at || JSON.stringify(trace).length > 16000) throw new Error('Invalid retained history candidate');
      db.prepare('INSERT OR IGNORE INTO proactive_retained_traces(id,mailbox,at,value) VALUES(?,?,?,?)')
        .run(trace.id, trace.source_mailbox, at, JSON.stringify({ ...trace, retained_at: at }));
    },
    walk(after = '', limit = 500): ProactiveTrace[] { return (db.prepare('SELECT value FROM proactive_retained_traces WHERE id>? ORDER BY id LIMIT ?').all(after, limit) as { value: string }[]).map(row => JSON.parse(row.value)); },
    recordCapture(mailbox: string, cutoff: number, at: number, candidates: number): void {
      db.prepare('INSERT OR IGNORE INTO proactive_history_capture_receipts(mailbox,cutoff,at,candidates) VALUES(?,?,?,?)').run(mailbox, cutoff, at, candidates);
    },
    receipts: () => db.prepare(`SELECT mailbox,cutoff,at,candidates FROM proactive_history_capture_receipts ${RECEIPT_ORDER} LIMIT ?`).all(CAPTURE_RECEIPTS_KEPT) as Array<{ mailbox: string; cutoff: number; at: number; candidates: number }>,
    pruneReceipts: (): number => db.prepare(`DELETE FROM proactive_history_capture_receipts WHERE rowid NOT IN
      (SELECT rowid FROM proactive_history_capture_receipts ${RECEIPT_ORDER} LIMIT ?)`).run(CAPTURE_RECEIPTS_KEPT).changes,
    forgetSource(mailbox: string): void { db.transaction(() => {
      db.prepare('DELETE FROM proactive_retained_traces WHERE mailbox=?').run(mailbox);
      db.prepare('DELETE FROM proactive_history_capture_receipts WHERE mailbox=?').run(mailbox);
    })(); },
    forget(): void { db.exec('DELETE FROM proactive_retained_traces; DELETE FROM proactive_history_capture_receipts'); },
  };
};
export type ProactiveTraceStore = ReturnType<typeof createProactiveTraceStore>;
