/** Ordinary dispatch uses the existing Commit/action identities. This host
 * adapter joins them to the same local transaction journal as future plans. */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { isCommit, isTerminalCommitStatus, RpcError, type Commit, type LocalMutationHooks,
  type LocalMutationReceiptSummary } from '@recued/contracts';
import { canonicalPendingCommit, commitWithOutcome, type CommitStore } from '@recued/storage';
import type { CommitRunIdentity } from '@recued/gateway';
import type { GatedActionRecord } from './gated-action-store.js';
import { withLocalMutationScope } from './local-mutation-context.js';
import { withContractDispatchReservation } from './contract-dispatch-reservation.js';
import { createOrdinaryLocalMutationReceipts, commitMutationIdentity,
  localMutationHash, reviewedLocalMutationKind } from './storage/ordinary-local-mutation-receipts.js';

export const localMutationSummary = (proof: LocalMutationReceiptSummary): LocalMutationReceiptSummary => ({
  receipt_id: proof.receipt_id, kind: proof.kind, committed_at: proof.committed_at,
});
export type OrdinaryLocalMutations = ReturnType<typeof createOrdinaryLocalMutations>;
type Call = Parameters<LocalMutationHooks['run']>[0];

export const createOrdinaryLocalMutations = (db: Database.Database, now: () => number = Date.now) => {
  const receipts = createOrdinaryLocalMutationReceipts(db, now);
  const read = (id: string): Commit | null => {
    const row = db.prepare('SELECT data FROM commits WHERE key=?').get(id) as { data: string } | undefined;
    try { const value: unknown = row ? JSON.parse(row.data) : null; return isCommit(value) ? value : null; }
    catch { return null; }
  };
  const proofFor = (commit: Commit) => commit.preapproval ? null
    : receipts.proof('ordinary_commit', commit.commit_id, commitMutationIdentity(commit));
  const project = (commit: Commit): Commit => {
    const proof = proofFor(commit);
    const { local_receipt: _savedSummary, ...history } = commit;
    return proof ? { ...history, local_receipt: localMutationSummary(proof) } : history;
  };
  return {
    forAction(action: GatedActionRecord): LocalMutationReceiptSummary | null {
      if (!action.resource_review || action.origin === 'preapproval_member') return null;
      try { const proof = receipts.forAction(action); return proof ? localMutationSummary(proof) : null; }
      catch { return null; }
    },
    wrapStore(base: CommitStore): CommitStore {
      return { ...base,
        async recordOutcome(id, outcome) {
          if (!receipts.has('ordinary_commit', id)) return base.recordOutcome(id, outcome);
          db.transaction(() => {
            const current = read(id);
            if (!current || current.preapproval) throw new Error('The local outcome has no ordinary pending Commit.');
            const proof = proofFor(current);
            const invalid = !proof && (receipts.hasJournal('ordinary_commit', id) || outcome.status === 'succeeded');
            const settled = proof && outcome.status !== 'succeeded'
              ? { status: 'succeeded' as const, completed_at: outcome.completed_at }
              : invalid ? { status: 'in_doubt' as const, completed_at: outcome.completed_at } : outcome;
            const updated = commitWithOutcome(current, settled);
            if (proof) updated.local_receipt = localMutationSummary(proof);
            db.prepare('UPDATE commits SET data=? WHERE key=?').run(JSON.stringify(updated), id);
          }).immediate();
        },
        async sweepPendingToInDoubt() {
          for (const pending of await base.listPending()) db.transaction(() => {
            const current = read(pending.commit_id);
            if (!current || isTerminalCommitStatus(current.status)) return;
            const proof = proofFor(current);
            if (!proof) return;
            const updated = { ...commitWithOutcome(current, { status: 'succeeded', completed_at: proof.committed_at }),
              local_receipt: localMutationSummary(proof) };
            db.prepare('UPDATE commits SET data=? WHERE key=?').run(JSON.stringify(updated), current.commit_id);
          }).immediate();
          return base.sweepPendingToInDoubt();
        },
        async get(id) { const commit = await base.get(id); return commit ? project(commit) : null; },
        async listPending() { return (await base.listPending()).map(project); },
        async listByRun(id, limit) { return (await base.listByRun(id, limit)).map(project); },
        async listByCorrelation(id, limit) { return (await base.listByCorrelation(id, limit)).map(project); },
        async listByChannelSession(id, limit) { return (await base.listByChannelSession(id, limit)).map(project); },
        async listByCognitionSession(id, limit) { return (await base.listByCognitionSession(id, limit)).map(project); },
      };
    },
    forRun(options: { identity: CommitRunIdentity; store: CommitStore; action_ref?: string; action_step_id?: string;
      single_action_step_id?: string; validate(call: Call): void }): LocalMutationHooks {
      return { async run(call, dispatch) {
        if (!reviewedLocalMutationKind(call.review)) return withLocalMutationScope(undefined, dispatch);
        const supplied = call.commit !== undefined;
        const pending = call.commit ?? canonicalPendingCommit({ ...options.identity,
          commit_id: 'c-' + randomUUID(), kind: 'action', ingredient: call.slug, tool: call.operation,
          // Records does not traverse the ingredient Commit gateway. Its exact
          // private values remain in the existing review, not this audit log.
          args: {}, idempotency_key: randomUUID(), dispatched_at: now() });
        if (pending.preapproval || pending.request_id !== options.identity.request_id
          || pending.ingredient !== call.slug || localMutationHash(pending.source) !== localMutationHash(options.identity.source)) {
          throw new Error('The local Commit does not preserve its original execution source.');
        }
        if (!supplied) await options.store.writePending(pending);
        try {
          withContractDispatchReservation(call.authority_reservation, () => options.validate(call));
          let action: GatedActionRecord | undefined;
          if (options.action_ref && options.action_step_id === call.stepMeta?.step_id
            && call.stepMeta?.preflight_admitted === true) {
            const row = db.prepare('SELECT data FROM gated_action_receipts WHERE key=?').get(options.action_ref) as { data: string } | undefined;
            action = row ? JSON.parse(row.data) as GatedActionRecord : undefined;
            if (!action || action.origin === 'preapproval_member' || action.status !== 'dispatching'
              || !action.dispatch_attempt_id || action.run_id !== pending.request_id
              || action.gated_step_id !== call.stepMeta?.step_id || action.settlement_mode === 'durable_handoff'
              || !action.resource_review || localMutationHash(action.resource_review) !== localMutationHash(call.review)) {
              throw new Error('The local operation does not own the approved action.');
            }
          }
          const current = () => {
            const commit = read(pending.commit_id);
            if (!commit || commit.preapproval || isTerminalCommitStatus(commit.status)) {
              throw new Error('The ordinary local Commit is no longer pending.');
            }
            return commitMutationIdentity(commit);
          };
          const scope = receipts.begin({ owner: 'ordinary_commit', ref: pending.commit_id,
            identity: commitMutationIdentity(pending), source: pending.source, review: call.review,
            ...(action ? { action, linkAction: options.single_action_step_id === call.stepMeta?.step_id } : {}), current,
            validate: () => withContractDispatchReservation(call.authority_reservation, () => options.validate(call)) });
          const result = await withLocalMutationScope(scope, dispatch);
          // Like the ordinary gateway, preserve the real tool result when
          // outcome bookkeeping fails. The atomic proof survives for recovery.
          if (!supplied) await options.store.recordOutcome(pending.commit_id,
            { status: 'succeeded', completed_at: now() }).catch(() => {});
          return result;
        } catch (error) {
          if (!supplied) await options.store.recordOutcome(pending.commit_id,
            { status: error instanceof RpcError && error.code === 'run_killed' ? 'cancelled' : 'failed',
              completed_at: now() }).catch(() => {});
          throw error;
        }
      } };
    },
  };
};
