/** Process ownership for durable D-261 runs. Heartbeats are diagnostic only:
 * only positive proof that the owner process is gone permits recovery. */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type Database from 'better-sqlite3';
import { RpcError } from '@recued/contracts';

const processInstance = randomUUID();
const processStartedAt = Math.floor(Date.now() - process.uptime() * 1_000);

export interface PreapprovalWorkerAuthority {
  assertCurrent(workerId: string): void;
  status(workerId: string): 'live' | 'gone' | 'unknown';
}
export interface PreapprovalWorkers extends PreapprovalWorkerAuthority {
  readonly worker_id: string;
  heartbeat(): void;
}
interface WorkerRow {
  worker_id: string; host: string; pid: number; process_instance: string;
  process_started_at: number; heartbeat_at: number;
}

export const createPreapprovalWorkers = (db: Database.Database): PreapprovalWorkers => {
  db.exec(`CREATE TABLE IF NOT EXISTS preapproval_workers (
    worker_id TEXT PRIMARY KEY, host TEXT NOT NULL, pid INTEGER NOT NULL,
    process_instance TEXT NOT NULL, process_started_at INTEGER NOT NULL,
    heartbeat_at INTEGER NOT NULL)`);
  const host = hostname();
  const workerId = `paw_${randomUUID()}`;
  db.prepare(`INSERT INTO preapproval_workers VALUES(?, ?, ?, ?, ?, ?)`)
    .run(workerId, host, process.pid, processInstance, processStartedAt, Date.now());
  const get = (id: string): WorkerRow | undefined => db.prepare('SELECT * FROM preapproval_workers WHERE worker_id = ?')
    .get(id) as WorkerRow | undefined;
  return {
    worker_id: workerId,
    assertCurrent(id) {
      const row = get(id);
      if (id !== workerId || row?.host !== host || row.pid !== process.pid || row.process_instance !== processInstance) {
        throw new RpcError('preapproval_already_claimed', 'This process does not own the execution worker.', 409);
      }
    },
    status(id) {
      const row = get(id);
      // A copied realm or remote process requires host-level evidence; an old
      // heartbeat on its own must not authorize a second external effect.
      if (!row || row.host !== host || !Number.isSafeInteger(row.pid) || row.pid <= 0) return 'unknown';
      // PID reuse (including a second module instance in this process) is
      // conservatively live. It can delay recovery; it cannot duplicate send.
      if (row.pid === process.pid) return 'live';
      try { process.kill(row.pid, 0); return 'live'; }
      catch (error) {
        return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH' ? 'gone' : 'unknown';
      }
    },
    heartbeat() {
      db.prepare('UPDATE preapproval_workers SET heartbeat_at = ? WHERE worker_id = ? AND process_instance = ?')
        .run(Date.now(), workerId, processInstance);
    },
  };
};
