/** The receipt and pending Commit are both actual existing-store rows. The
 * repository invokes this participant in the same transaction as member CAS;
 * the gateway supplies its ordinary, freshly resolved commit provenance. */
import type Database from 'better-sqlite3';
import { RpcError, executionSourceContractId, isCommit, isTerminalCommitStatus, type Commit } from '@recued/contracts';
import { canonicalPendingCommit, commitWithOutcome, type PendingCommitInput } from '@recued/storage';
import type { SqliteGatedActionChangeClock } from '../gated-action-store.js';
import type { PreparedFutureExecution, PreparedInvocation, PreapprovalMemberClaim } from '../preapproval-model.js';
import { preapprovalHash } from '../preapproval-invocations.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import type { PreapprovalAtomicHooks } from './preapproval-repository.js';
import { createSqlitePreapprovalReceiptParticipant } from './preapproval-receipts.js';

/** Also used during authenticated archive staging, where no execution/vault
 * service may be created and no new commit can be dispatched. */
export const createSqlitePreapprovalSettlementParticipant = (
  db: Database.Database, clock: SqliteGatedActionChangeClock, now: () => number = Date.now,
): PreapprovalAtomicHooks['settleDispatch'] => {
  const receipts = createSqlitePreapprovalReceiptParticipant(db, clock, now);
  createSQLiteCollection<Commit>(db, 'commits');
  return (claim, outcome) => {
    if (!db.inTransaction) throw new Error('Pre-approval commits require the realm authority transaction.');
    if (!claim.commit_id) throw new Error('The reviewed invocation has no durable pending commit.');
    const row = db.prepare('SELECT data FROM commits WHERE key = ?').get(claim.commit_id) as { data: string } | undefined;
    const record: unknown = row ? JSON.parse(row.data) : null;
    if (!isCommit(record) || record.request_id !== claim.run_id || record.idempotency_key !== claim.idempotency_key
      || record.preapproval?.future_execution_ref !== claim.future_execution_ref
      || record.preapproval.grant_id !== claim.grant_id || record.preapproval.member_id !== claim.member_id
      || record.preapproval.action_ref !== claim.action_ref) throw new Error('The outcome does not own this pending commit.');
    if (isTerminalCommitStatus(record.status)) {
      if (record.status !== outcome.status) {
        throw new RpcError('preapproval_in_doubt', 'The immutable commit outcome requires reconciliation.', 409);
      }
    } else {
      const next = commitWithOutcome(record, { status: outcome.status, completed_at: now() });
      const changed = db.prepare(`UPDATE commits SET data = ? WHERE key = ?
        AND json_extract(data, '$.status') IN ('pending', 'running')`)
        .run(JSON.stringify(next), record.commit_id);
      if (changed.changes !== 1) throw new Error('The pre-approval commit changed during settlement.');
    }
    receipts.settle(claim, outcome.status);
  };
};

export const createSqlitePreapprovalDispatchParticipant = (
  db: Database.Database, clock: SqliteGatedActionChangeClock,
  options: {
    /** Pure, synchronous gateway envelope construction. This must re-read the
     * current contract snapshot; it cannot promote the stored origin. */
    buildPendingCommit(claim: Omit<PreapprovalMemberClaim, 'commit_id'>,
      member: PreparedInvocation, plan: PreparedFutureExecution): PendingCommitInput;
    now?: () => number;
  },
): Pick<PreapprovalAtomicHooks, 'createDispatch' | 'settleDispatch'> => {
  const now = options.now ?? Date.now;
  const receipts = createSqlitePreapprovalReceiptParticipant(db, clock, now);
  createSQLiteCollection<Commit>(db, 'commits');
  const assertTransaction = (): void => {
    if (!db.inTransaction) throw new Error('Pre-approval commits require the realm authority transaction.');
  };
  return {
    createDispatch(claim, member, plan) {
      assertTransaction();
      const actionRef = receipts.create(claim, member);
      const candidate = options.buildPendingCommit({ ...claim, action_ref: actionRef }, member, plan);
      if (!candidate || preapprovalHash(candidate.source) !== preapprovalHash(plan.origin.source)
        || candidate.ingredient !== member.ingredient_slug || candidate.request_id !== claim.run_id) {
        throw new Error('The pending commit does not preserve the reviewed invocation and origin.');
      }
      const contractId = executionSourceContractId(plan.origin.source);
      if (contractId !== undefined && candidate.contract_snapshot?.contract_id !== contractId) {
        throw new Error('The pre-approved commit requires its original live contract snapshot.');
      }
      const pending = canonicalPendingCommit({ ...candidate,
        // Reviewed private input/output remains in the encrypted member
        // snapshot. Audit readers can follow the explicit preapproval link.
        args: {}, idempotency_key: claim.idempotency_key,
        preapproval: { future_execution_ref: claim.future_execution_ref,
          grant_id: claim.grant_id, member_id: claim.member_id, action_ref: actionRef },
      });
      if (!isCommit(pending)) throw new Error('The gateway did not construct a valid pending commit.');
      const inserted = db.prepare('INSERT INTO commits(key, data) VALUES(?, ?) ON CONFLICT(key) DO NOTHING')
        .run(pending.commit_id, JSON.stringify(pending));
      if (inserted.changes !== 1) throw new Error('The pending pre-approval commit already exists.');
      return { action_ref: actionRef, commit_id: pending.commit_id };
    },
    settleDispatch: createSqlitePreapprovalSettlementParticipant(db, clock, now),
  };
};
