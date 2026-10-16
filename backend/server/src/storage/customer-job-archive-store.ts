import type Database from 'better-sqlite3';
import { ensureCustomerJobReadIndex } from './customer-job-read-index.js';
import { QuoteSignoffError } from '../quote-signoff-service.js';
import type { CustomerJobArchiveRecord,CustomerJobArchiveEvent } from '@recued/contracts';

export interface CustomerJobArchiveRow extends CustomerJobArchiveRecord { fingerprint: string | null;review_hash: string | null }
export const jobArchiveTableExists = (db: Database.Database,table = 'customer_job_archives') => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
export const isCustomerJobArchived = (db: Database.Database,jobId: string) => jobArchiveTableExists(db)
  && Boolean(db.prepare('SELECT 1 FROM customer_job_archives WHERE job_id=? AND archived_at IS NOT NULL').get(jobId));
export const isCustomerSignoffArchived = (db: Database.Database,signoffId: string) => {
  if (!jobArchiveTableExists(db)) return false;
  return Boolean(db.prepare(`SELECT 1 FROM quote_signoffs s JOIN customer_job_archives a
    ON a.job_id=COALESCE(json_extract(s.plan_json,'$.addition.root_signoff_id'),s.signoff_id)
    WHERE s.signoff_id=? AND a.archived_at IS NOT NULL`).get(signoffId));
};
export const createCustomerJobArchiveStore = (db: Database.Database) => {
  db.exec(`CREATE TABLE IF NOT EXISTS customer_job_archives (
    job_id TEXT PRIMARY KEY REFERENCES quote_signoffs(signoff_id),revision INTEGER NOT NULL,
    archived_at INTEGER,updated_at INTEGER NOT NULL,fingerprint TEXT,review_hash TEXT
  ); CREATE TABLE IF NOT EXISTS customer_job_archive_events (
    job_id TEXT NOT NULL REFERENCES quote_signoffs(signoff_id),revision INTEGER NOT NULL,
    action TEXT NOT NULL,recorded_at INTEGER NOT NULL,owner_instance_id TEXT NOT NULL,review_hash TEXT,
    PRIMARY KEY(job_id,revision)
  );`);
  ensureCustomerJobReadIndex(db);
  const read = (id: string) => {
    const row = db.prepare('SELECT * FROM customer_job_archives WHERE job_id=?').get(id) as CustomerJobArchiveRow | undefined;
    if (row && (!Number.isSafeInteger(row.revision) || row.revision < 1 || !Number.isSafeInteger(row.updated_at) || row.updated_at! < 0
      || row.archived_at !== null && (!Number.isSafeInteger(row.archived_at) || row.archived_at < 0 || typeof row.fingerprint !== 'string'
        || !/^[a-f0-9]{64}$/.test(row.fingerprint) || typeof row.review_hash !== 'string' || !/^[a-f0-9]{64}$/.test(row.review_hash))
      || row.archived_at === null && (row.fingerprint !== null || row.review_hash !== null))) {
      throw new QuoteSignoffError('customer_job_archive_unavailable','The saved job archive needs review in Records.');
    }
    return row;
  };
  const state = (id: string): CustomerJobArchiveRecord => {
    const row = read(id);return { job_id: id,revision: row?.revision ?? 0,archived_at: row?.archived_at ?? null,updated_at: row?.updated_at ?? null };
  };
  return { read,state,
    history(id: string) {
      const rows = db.prepare('SELECT revision,action,recorded_at FROM customer_job_archive_events WHERE job_id=? ORDER BY revision DESC LIMIT 51').all(id) as CustomerJobArchiveEvent[];
      return { events: rows.slice(0,50),has_older_events: rows.length > 50 };
    },
    write(id: string,revision: number,action: 'archive' | 'restore',at: number,actor: string,fingerprint: string | null,reviewHash: string | null) {
      db.prepare(`INSERT INTO customer_job_archives (job_id,revision,archived_at,updated_at,fingerprint,review_hash) VALUES (?,?,?,?,?,?)
        ON CONFLICT(job_id) DO UPDATE SET revision=excluded.revision,archived_at=excluded.archived_at,updated_at=excluded.updated_at,fingerprint=excluded.fingerprint,review_hash=excluded.review_hash`)
        .run(id,revision,action === 'archive' ? at : null,at,fingerprint,reviewHash);
      db.prepare('INSERT INTO customer_job_archive_events (job_id,revision,action,recorded_at,owner_instance_id,review_hash) VALUES (?,?,?,?,?,?)')
        .run(id,revision,action,at,actor,reviewHash);
      return state(id);
    },
  };
};
