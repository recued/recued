/** Private attempt bindings for ordinary Commit and Chat-plan owners. These
 * rows grant nothing; only a journal entry in the data transaction proves an
 * effect. Hashes retain identity without copying arguments or review values. */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { isCommit, type Commit, type ExecutionSource, type ResourceReview } from '@recued/contracts';
import { canonicalJSONStringifyStrict, sha256Hex } from '@recued/crypto';
import { createSqliteGatedActionChangeClock, type GatedActionRecord } from '../gated-action-store.js';
import type { LocalMutationScope } from '../local-mutation-context.js';
import { createLocalMutationReceipts, type LocalMutationReceiptBinding } from './local-mutation-receipts.js';

export const localMutationHash = (value: unknown): string => 'sha256:' + sha256Hex(canonicalJSONStringifyStrict(value));
export const reviewedLocalMutationKind = (review: ResourceReview): LocalMutationReceiptBinding['kind'] | null =>
  review.resources.length > 0 && review.resources.every(resource => resource.kind === 'records') ? 'records'
    : review.resources.length === 1 && review.resources[0]!.kind === 'calendar'
      && review.resources[0]!.precondition.kind === 'local_version'
      && ['calendar-update', 'calendar-delete'].includes(review.operation) ? 'local_calendar' : null;

export const commitMutationIdentity = (commit: Commit): unknown => {
  const { status: _status, output: _output, completed_at: _completed, duration_ms: _duration,
    cached: _cached, detail: _detail, local_receipt: _receipt, ...identity } = commit;
  return identity;
};
export const gatedMutationIdentity = (action: GatedActionRecord): unknown => ({
  action_ref: action.action_ref, run_id: action.run_id, gated_step_id: action.gated_step_id,
  checkpoint_id: action.current_checkpoint_id ?? null, attempt_id: action.dispatch_attempt_id ?? null,
  ingredient: action.ingredient_slug ?? null, operation: action.operation_id ?? null,
  resource_review: action.resource_review ?? null, approved_bound: action.approved_bound ?? null,
});
interface Attempt {
  attempt_id: string; owner: 'ordinary_commit' | 'chat_plan'; owner_ref: string;
  owner_hash: string; source_hash: string; epoch: string; operation: string;
  kind: LocalMutationReceiptBinding['kind']; review_hash: string;
  action_ref: string | null; action_hash: string | null;
}
const bindingFor = (row: Attempt): LocalMutationReceiptBinding => ({
  owner: row.owner, owner_ref: row.owner_ref, attempt_id: row.attempt_id,
  operation: row.operation, kind: row.kind, review_hash: row.review_hash,
  identity_hash: localMutationHash(row),
});

export const createOrdinaryLocalMutationReceipts = (db: Database.Database, now: () => number = Date.now) => {
  const journal = createLocalMutationReceipts(db, now);
  const clock = createSqliteGatedActionChangeClock(db);
  db.exec(`CREATE TABLE IF NOT EXISTS ordinary_local_mutation_attempts (
    attempt_id TEXT PRIMARY KEY, owner TEXT NOT NULL, owner_ref TEXT NOT NULL,
    owner_hash TEXT NOT NULL, source_hash TEXT NOT NULL, epoch TEXT NOT NULL,
    operation TEXT NOT NULL, kind TEXT NOT NULL, review_hash TEXT NOT NULL,
    action_ref TEXT, action_hash TEXT, UNIQUE(owner,owner_ref));
    CREATE INDEX IF NOT EXISTS ordinary_local_mutation_action ON ordinary_local_mutation_attempts(action_ref);`);
  const get = (owner: Attempt['owner'], ref: string): Attempt | undefined => db.prepare(
    'SELECT * FROM ordinary_local_mutation_attempts WHERE owner=? AND owner_ref=?').get(owner, ref) as Attempt | undefined;
  const proof = (owner: Attempt['owner'], ref: string, identity: unknown) => {
    const row = get(owner, ref);
    if (!row || row.epoch !== clock.snapshot().epoch || row.owner_hash !== localMutationHash(identity)) return null;
    return journal.find(bindingFor(row));
  };
  return {
    proof,
    has: (owner: Attempt['owner'], ref: string) => get(owner, ref) !== undefined,
    hasJournal: (owner: Attempt['owner'], ref: string) => {
      const row = get(owner, ref);
      return row !== undefined && journal.hasAttempt(row.attempt_id);
    },
    /** Called only after the existing owner has irreversibly claimed dispatch. */
    begin(input: { owner: Attempt['owner']; ref: string; identity: unknown; source: ExecutionSource;
      review: ResourceReview; action?: GatedActionRecord; linkAction?: boolean; current(): unknown; validate(): void }): LocalMutationScope {
      const kind = reviewedLocalMutationKind(input.review);
      if (!kind) throw new Error('This mutation has no supported local receipt boundary.');
      const row: Attempt = { attempt_id: 'lma_' + randomUUID(), owner: input.owner, owner_ref: input.ref,
        owner_hash: localMutationHash(input.identity), source_hash: localMutationHash(input.source),
        epoch: clock.snapshot().epoch, operation: input.review.operation, kind, review_hash: localMutationHash(input.review),
        // A foreach item still fences its original claim, but its one effect
        // cannot establish the whole action's completion during recovery.
        action_ref: input.linkAction === false ? null : input.action?.action_ref ?? null,
        action_hash: input.action ? localMutationHash(gatedMutationIdentity(input.action)) : null };
      const actionRef = input.action?.action_ref;
      const assertCurrent = () => {
        if (row.epoch !== clock.snapshot().epoch || localMutationHash(input.current()) !== row.owner_hash) {
          throw new Error('The local mutation no longer owns its original dispatch.');
        }
      };
      db.transaction(() => {
        assertCurrent();
        db.prepare(`INSERT INTO ordinary_local_mutation_attempts VALUES(
          @attempt_id,@owner,@owner_ref,@owner_hash,@source_hash,@epoch,@operation,@kind,@review_hash,@action_ref,@action_hash)`).run(row);
      }).immediate();
      return { record(connection, actualKind, review) {
        if (connection !== db || !db.inTransaction) throw new Error('The local mutation and receipt must share their database transaction.');
        assertCurrent();
        if (actualKind !== kind || localMutationHash(review) !== row.review_hash) {
          throw new Error('The local mutation differs from its reviewed operation.');
        }
        if (actionRef) {
          const saved = db.prepare('SELECT data FROM gated_action_receipts WHERE key=?').get(actionRef) as { data: string } | undefined;
          const action = saved ? JSON.parse(saved.data) as GatedActionRecord : null;
          if (!action || action.status !== 'dispatching' || localMutationHash(gatedMutationIdentity(action)) !== row.action_hash) {
            throw new Error('The approved action no longer owns this mutation.');
          }
        }
        const completed = input.validate();
        if (completed !== undefined) throw new Error('Local mutation authority checks must finish synchronously.');
        journal.record(bindingFor(row));
      } };
    },
    /** One direct reviewed action can inherit its own Commit's proof. A
     * broader action or a collection of attempts is never inferred complete. */
    forAction(action: GatedActionRecord) {
      const rows = db.prepare('SELECT * FROM ordinary_local_mutation_attempts WHERE action_ref=? AND epoch=?')
        .all(action.action_ref, clock.snapshot().epoch) as Attempt[];
      if (rows.length !== 1 || rows[0]!.action_hash !== localMutationHash(gatedMutationIdentity(action))) return null;
      const row = rows[0]!;
      const saved = db.prepare('SELECT data FROM commits WHERE key=?').get(row.owner_ref) as { data: string } | undefined;
      const commit: unknown = saved ? JSON.parse(saved.data) : null;
      return isCommit(commit) && !commit.preapproval ? proof('ordinary_commit', row.owner_ref, commitMutationIdentity(commit)) : null;
    },
  };
};
