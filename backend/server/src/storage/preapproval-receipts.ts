/** The real owner-facing gated-action receipt participant for D-261. Both
 * writes run inside the repository's realm transaction; no async collection
 * call or notification is allowed to split a member from its receipt. */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { isGatedActionTerminal } from '@recued/contracts';
import {
  GATED_ACTION_TABLE, GATED_ACTION_TERMINAL_RETENTION_MS,
  isGatedActionRecord, type GatedActionRecord, type SqliteGatedActionChangeClock,
} from '../gated-action-store.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import type { PreparedInvocation, PreapprovalMemberClaim } from '../preapproval-model.js';

type UnreceiptedClaim = Omit<PreapprovalMemberClaim, 'action_ref' | 'commit_id'>;
export interface PreapprovalReceiptParticipant {
  create(claim: UnreceiptedClaim, member: PreparedInvocation): string;
  settle(claim: PreapprovalMemberClaim, status: 'succeeded' | 'failed' | 'in_doubt'): void;
}

export const createSqlitePreapprovalReceiptParticipant = (
  db: Database.Database, clock: SqliteGatedActionChangeClock, now: () => number = Date.now,
): PreapprovalReceiptParticipant => {
  // Use the established collection's table/schema; direct writes below only
  // add synchronous participation, not a competing receipt storage format.
  createSQLiteCollection<GatedActionRecord>(db, GATED_ACTION_TABLE);
  const assertTransaction = (): void => {
    if (!db.inTransaction) throw new Error('Pre-approval receipts require the realm authority transaction.');
  };
  const get = (actionRef: string): GatedActionRecord | null => {
    const row = db.prepare(`SELECT data FROM ${GATED_ACTION_TABLE} WHERE key = ?`).get(actionRef) as { data: string } | undefined;
    if (!row) return null;
    const value: unknown = JSON.parse(row.data);
    if (!isGatedActionRecord(value)) throw new Error('The linked pre-approval receipt is corrupt.');
    return value;
  };
  const owns = (record: GatedActionRecord, claim: UnreceiptedClaim): boolean =>
    record.origin === 'preapproval_member' && record.dispatch_attempt_id === claim.attempt_id
      && record.run_id === claim.run_id && record.preapproval.root_run_id === claim.root_run_id
      && record.preapproval.future_execution_ref === claim.future_execution_ref
      && record.preapproval.grant_id === claim.grant_id && record.preapproval.member_id === claim.member_id;
  return {
    create(claim, member) {
      assertTransaction();
      const grant = db.prepare(`SELECT proposal_id FROM preapproval_grants
        WHERE grant_id = ? AND future_ref = ? AND status = 'active'`)
        .get(claim.grant_id, claim.future_execution_ref) as { proposal_id: string } | undefined;
      if (!grant || member.member_id !== claim.member_id) throw new Error('Missing active pre-approval decision for this receipt.');
      const actionRef = `act_${createHash('sha256').update(JSON.stringify([
        'preapproval_member', claim.future_execution_ref, claim.member_id, claim.attempt_id,
      ])).digest('hex')}`;
      const prior = get(actionRef);
      if (prior) {
        if (!owns(prior, claim)) throw new Error('Pre-approval receipt identity conflict.');
        return prior.action_ref;
      }
      const step = [...member.invocation_path].reverse().find(segment => segment.kind === 'step');
      const recipe = [...member.invocation_path].reverse().find(segment => segment.kind === 'recipe');
      if (step?.kind !== 'step' || recipe?.kind !== 'recipe') throw new Error('The reviewed invocation has no engine step.');
      const timestamp = now();
      const record: GatedActionRecord = {
        schema_version: 1, origin: 'preapproval_member', action_ref: actionRef, approval_ref: claim.grant_id,
        run_id: claim.run_id, recipe_id: recipe.recipe_id, gated_step_id: step.step_id,
        ingredient_slug: member.ingredient_slug, operation_id: member.op_id,
        ...(member.connection_id === null ? {} : { connection_name: member.connection_id }),
        status: 'dispatching', status_message: 'Owner pre-approved this operation; dispatching the reviewed invocation.',
        dispatch_attempt_id: claim.attempt_id, settlement_mode: 'returned_result',
        created_at: timestamp, updated_at: timestamp, revision: 1, change_seq: clock.nextChangeSeqSync(),
        preapproval: { future_execution_ref: claim.future_execution_ref, proposal_id: grant.proposal_id,
          grant_id: claim.grant_id, member_id: claim.member_id, root_run_id: claim.root_run_id,
          parent_member_id: member.parent_member_id },
      };
      if (!isGatedActionRecord(record)) throw new Error('Invalid pre-approval receipt.');
      db.prepare(`INSERT INTO ${GATED_ACTION_TABLE}(key, data) VALUES(?, ?)`).run(actionRef, JSON.stringify(record));
      return actionRef;
    },
    settle(claim, status) {
      assertTransaction();
      const record = get(claim.action_ref);
      if (!record || !owns(record, claim)) throw new Error('The outcome does not own the pre-approval receipt.');
      // Even a later positive reconciliation cannot rewrite uncertainty.
      if (isGatedActionTerminal(record.status)) return;
      if (record.status !== 'dispatching') throw new Error('The pre-approval receipt was never dispatched.');
      const timestamp = now();
      const next: GatedActionRecord = { ...record, status,
        status_message: status === 'succeeded' ? 'The reviewed operation succeeded.'
          : status === 'failed' ? 'The reviewed operation failed.' : 'The operation outcome is uncertain; it will not be resent automatically.',
        updated_at: Math.max(timestamp, record.updated_at), terminal_at: timestamp,
        expires_at: timestamp + GATED_ACTION_TERMINAL_RETENTION_MS,
        revision: record.revision + 1, change_seq: clock.nextChangeSeqSync(),
      };
      const written = db.prepare(`UPDATE ${GATED_ACTION_TABLE} SET data = ?
        WHERE key = ? AND json_extract(data, '$.revision') = ?`)
        .run(JSON.stringify(next), record.action_ref, record.revision);
      if (written.changes !== 1) throw new Error('The pre-approval receipt changed during settlement.');
    },
  };
};
