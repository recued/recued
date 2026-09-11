/** Restore/import authority cutoff. Runs on the authenticated staging database
 * before it can replace the live realm. It needs no decrypted plan or vault. */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { PreapprovalMemberClaim } from '../preapproval-model.js';
import type { PreapprovalAtomicHooks } from './preapproval-repository.js';

export const invalidatePreapprovalLineage = (
  db: Database.Database, settleDispatch: PreapprovalAtomicHooks['settleDispatch'], now = Date.now(),
): void => {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'preapproval_state'").get()) return;
  db.transaction(() => {
    const unfinished = db.prepare(`SELECT future_ref, revision, root_run_id, worker_id, fence FROM preapproval_executions
      WHERE state IN ('prepared','active','running','held','in_doubt')`).all() as {
        future_ref: string; revision: number; root_run_id: string | null; worker_id: string | null; fence: number;
      }[];
    for (const execution of unfinished) {
      const dispatching = db.prepare(`SELECT member_id, grant_id, attempt_id, idempotency_key, action_ref,
        commit_id, parent_attempt_id, actual_run_id FROM preapproval_members WHERE future_ref = ? AND state = 'dispatching'`)
        .all(execution.future_ref) as {
          member_id: string; grant_id: string; attempt_id: string; idempotency_key: string; action_ref: string;
          commit_id: string | null; parent_attempt_id: string | null; actual_run_id: string;
        }[];
      for (const member of dispatching) {
        if (!execution.root_run_id || !execution.worker_id || !member.attempt_id || !member.action_ref || !member.actual_run_id) {
          throw new Error('Restored pre-approval attempt has incomplete durable identity.');
        }
        const claim: PreapprovalMemberClaim = { ...member,
          future_execution_ref: execution.future_ref, root_run_id: execution.root_run_id,
          run_id: member.actual_run_id, worker_id: execution.worker_id, fence: execution.fence,
        };
        const settled = settleDispatch(claim, { status: 'in_doubt', message: 'Restored attempt requires review.', result: null });
        if (settled !== undefined) throw new Error('Pre-approval restore settlement must complete synchronously.');
      }
      db.prepare(`UPDATE preapproval_members SET state = 'in_doubt', revision = revision + 1,
        updated_at = ? WHERE future_ref = ? AND state = 'dispatching'`).run(now, execution.future_ref);
      db.prepare(`UPDATE preapproval_members SET state = 'invalidated', revision = revision + 1,
        updated_at = ? WHERE future_ref = ? AND state = 'available'`).run(now, execution.future_ref);
      const states = db.prepare('SELECT state FROM preapproval_members WHERE future_ref = ?')
        .all(execution.future_ref) as { state: string }[];
      const status = states.some(row => row.state === 'in_doubt') ? 'in_doubt'
        : states.some(row => row.state === 'succeeded') ? 'partial' : 'invalidated';
      db.prepare(`UPDATE preapproval_executions SET state = ?, stop_requested = 1, status_reason = 'restored_lineage',
        fence = fence + 1, revision = revision + 1, updated_at = ? WHERE future_ref = ?`)
        .run(status, now, execution.future_ref);
      db.prepare(`UPDATE preapproval_proposals SET status = 'invalidated', updated_at = ?
        WHERE future_ref = ? AND status = 'awaiting_owner'`).run(now, execution.future_ref);
      db.prepare(`UPDATE preapproval_grants SET status = 'invalidated', revision = revision + 1
        WHERE future_ref = ? AND status = 'active'`).run(execution.future_ref);
      // Old delivery/activation tasks cannot be replayed after import.
      db.prepare("UPDATE preapproval_outbox SET state = 'done', lease_until = 0 WHERE future_ref = ?")
        .run(execution.future_ref);
      db.prepare(`INSERT INTO preapproval_outbox(event_id, future_ref, kind, payload_json) VALUES(?, ?, 'execution_stopped', ?)`)
        .run(`${execution.future_ref}:${execution.revision + 1}:restored_lineage`, execution.future_ref,
          JSON.stringify({ reason: 'restored_lineage' }));
    }
    db.prepare('UPDATE preapproval_state SET lineage = ? WHERE singleton = 1').run(randomUUID());
    db.prepare('DELETE FROM preapproval_challenges WHERE consumed_decision_id IS NULL').run();
    db.prepare('DELETE FROM preapproval_deliveries').run();
    // The activation writer parks old schedules/autoruns/triggers before
    // acceptance. Leave those disabled; no restore path re-arms them.
  }).immediate();
};
