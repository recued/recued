/** Host-owned participation in a local write transaction. A receipt proves a
 * committed effect; it is never an admission decision or a replay permit. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { consumeScheduledLocalAuthority } from './scheduled-local-authority-context.js';
import type Database from 'better-sqlite3';
import { RpcError, type LocalMutationReceiptSummary, type ResourceReview } from '@recued/contracts';
import { currentRunAbortContext } from './execution/run-abort-context.js';
import { withLocalUpdateInverse, type LocalUpdateInverse } from './local-update-undo-context.js';

export interface LocalMutationScope {
  record(db: Database.Database, kind: LocalMutationReceiptSummary['kind'], review: ResourceReview): void;
}
const scopes = new AsyncLocalStorage<LocalMutationScope | undefined>();
export const withLocalMutationScope = <T>(scope: LocalMutationScope | undefined, run: () => T): T => scopes.run(scope, run);

/** The built-in store calls this once, after all its writes and validators,
 * before committing. Receipt failure must roll back the entire mutation. */
export const recordLocalMutation = (db: Database.Database, kind: LocalMutationReceiptSummary['kind'], review: ResourceReview,
  inverse?: LocalUpdateInverse): void => {
  consumeScheduledLocalAuthority(db);
  const scope = scopes.getStore();
  if (!scope) return;
  if (!db.inTransaction) throw new Error('Local mutation evidence requires the mutation transaction.');
  // Future approvals and ordinary runs share this final transactional fence.
  // Preparation may have yielded after either path's dispatch admission.
  if (currentRunAbortContext()?.signal?.aborted) {
    throw new RpcError('run_killed', 'The run stopped before its local write.', 409);
  }
  // Neither validators nor observers may borrow this invocation's participant.
  const completed = withLocalUpdateInverse(inverse, () => scopes.run(undefined, () => scope.record(db, kind, review)));
  if (completed !== undefined) throw new Error('Local mutation participants must finish synchronously.');
};
