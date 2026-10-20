import { inverseLocalUpdateCall, localUpdateInput } from './local-update-operation.js';
/** Paired-owner, one-use review of a confirmed local update's inverse.
 * The old approval grants nothing here. Normal admission, manifest bindings,
 * store validators and CAS still apply to the newly approved operation. */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { isResourceReview, RpcError,
  type LocalUpdateUndoReview, type LocalUpdateUndoDecision, type LocalUpdateUndoResult,
  type ResourceReview } from '@recued/contracts';
import type { ExecuteHandlerDeps } from './execute-handler.js';
import type { PreapprovalOrigin } from './preapproval-model.js';
import type { LocalUpdateInverse } from './local-update-undo-context.js';
import type { LocalUpdateUndoStore } from './storage/local-update-undo-store.js';
import type { LocalMutationReceipt } from './storage/local-mutation-receipts.js';
import { localMutationHash } from './storage/ordinary-local-mutation-receipts.js';
import { resourceReviewHash, withResourceReview } from './resource-review.js';
import { withLocalMutationScope } from './local-mutation-context.js';
import type { PreapprovalWorkers } from './storage/preapproval-workers.js';

type UndoCall = import('./local-update-operation.js').LocalUpdateCall;
interface SealedReview {
  public: LocalUpdateUndoReview; origin: Extract<PreapprovalOrigin, { mode: 'owner' }>; receipt: LocalMutationReceipt;
  inverse: LocalUpdateInverse; call: UndoCall; epoch: string; retained_until: number;
}
interface UndoRow {
  undo_id: string; predecessor_receipt_id: string; review_hash: string; epoch: string; expires_at: number;
  status: 'pending' | 'dispatching' | LocalUpdateUndoResult['status']; decision: string | null;
  encrypted: string; retained_until: number; worker_id: string | null;
  owner_id: string; credential_id: string; created_at: number; decided_at: number | null;
  operation: string; kind: LocalMutationReceipt['kind']; resource_review_hash: string;
}
const conflict = (detail: string): never => { throw new RpcError('local_undo_conflict', detail, 409); };
const object = (raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new RpcError('bad_request', 'Invalid undo request.', 400);
  return raw as Record<string, unknown>;
};
export const parseLocalUndoReceipt = (raw: unknown): string => {
  const value = object(raw);
  if (Object.keys(value).length !== 1 || typeof value.receipt_id !== 'string' || !/^lmr_[a-f0-9-]{36}$/.test(value.receipt_id)) {
    throw new RpcError('bad_request', 'Choose a confirmed local change to review.', 400);
  }
  return value.receipt_id;
};
export const parseLocalUndoDecision = (raw: unknown): LocalUpdateUndoDecision => {
  const value = object(raw);
  if (Object.keys(value).sort().join(',') !== 'decision,review_hash,undo_id'
    || typeof value.undo_id !== 'string' || !/^undo_[a-f0-9-]{36}$/.test(value.undo_id)
    || typeof value.review_hash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.review_hash)
    || (value.decision !== 'approve' && value.decision !== 'deny')) throw new RpcError('bad_request', 'Invalid undo decision.', 400);
  return { undo_id: value.undo_id, review_hash: value.review_hash, decision: value.decision };
};

export const createLocalUpdateUndo = (deps: {
  db: Database.Database; store: LocalUpdateUndoStore; execution: ExecuteHandlerDeps;
  workers: PreapprovalWorkers;
  validate(origin: PreapprovalOrigin, call: UndoCall): void;
  now?: () => number;
}) => {
  const { db, store, execution } = deps;
  const now = deps.now ?? Date.now;
  db.exec(`CREATE TABLE IF NOT EXISTS local_update_undo_reviews (
    undo_id TEXT PRIMARY KEY, predecessor_receipt_id TEXT NOT NULL, review_hash TEXT NOT NULL,
    epoch TEXT NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL, decision TEXT,
    encrypted TEXT NOT NULL, retained_until INTEGER NOT NULL, worker_id TEXT,
    owner_id TEXT NOT NULL, credential_id TEXT NOT NULL, created_at INTEGER NOT NULL, decided_at INTEGER,
    operation TEXT NOT NULL, kind TEXT NOT NULL, resource_review_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS local_update_undo_links (
    predecessor_receipt_id TEXT PRIMARY KEY, undo_receipt_id TEXT NOT NULL UNIQUE, undo_id TEXT NOT NULL UNIQUE);`);
  // A draft database without proof metadata remains readable but cannot assert
  // completion from an unbound receipt. New reviews always save these fields.
  const columns = db.prepare('PRAGMA table_info(local_update_undo_reviews)').all() as { name: string }[];
  for (const column of ['operation', 'kind', 'resource_review_hash']) {
    if (!columns.some(value => value.name === column)) db.exec(`ALTER TABLE local_update_undo_reviews ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS local_update_undo_by_receipt ON local_update_undo_reviews(predecessor_receipt_id,created_at)');
  // An interrupted claim is recovery-only. A committed row was completed in
  // the data transaction; absence of that fact never permits another dispatch.
  for (const row of db.prepare("SELECT undo_id,worker_id FROM local_update_undo_reviews WHERE status='dispatching'").all() as {
    undo_id: string; worker_id: string | null;
  }[]) {
    if (row.worker_id && deps.workers.status(row.worker_id) === 'gone') {
      db.prepare("UPDATE local_update_undo_reviews SET status='unknown' WHERE undo_id=? AND status='dispatching'").run(row.undo_id);
    }
  }
  const prune = (): void => {
    store.prune();
    db.prepare("UPDATE local_update_undo_reviews SET encrypted='' WHERE encrypted<>'' AND (retained_until<=? OR epoch<>?)")
      .run(now(), store.clock.snapshot().epoch);
  };
  prune();
  const rowFor = (id: string): UndoRow | undefined => db.prepare('SELECT * FROM local_update_undo_reviews WHERE undo_id=?')
    .get(id) as UndoRow | undefined;
  const linked = (id: string): boolean => Boolean(db.prepare('SELECT 1 FROM local_update_undo_links WHERE predecessor_receipt_id=?').get(id));
  const callFor = (inverse: LocalUpdateInverse): UndoCall => inverseLocalUpdateCall(inverse, execution.executorConfig.manifests);
  const dispatchInput = (saved: SealedReview): Record<string, unknown> => localUpdateInput(saved.call, saved.inverse);
  const validate = (saved: SealedReview, checkResource = true): ResourceReview => {
    store.assertAvailable(saved.receipt);
    if (saved.epoch !== store.clock.snapshot().epoch || saved.public.expires_at <= now()) return conflict('This undo review expired. Request a new review.');
    if (linked(saved.receipt.receipt_id)) return conflict('This change already has an undo receipt.');
    const call = callFor(saved.inverse);
    if (localMutationHash(call) !== localMutationHash(saved.call)) return conflict('The reverse operation changed. Request a new review.');
    deps.validate(saved.origin, call);
    if (!checkResource) return saved.public.resource_review;
    const hooks = execution.executorConfig.resourceReview;
    const fresh = hooks?.capture(call.slug, dispatchInput(saved));
    if (!isResourceReview(fresh)) return conflict('Version-bound undo is unavailable.');
    const inverse = saved.inverse;
    if (inverse.kind === 'records') {
      if (resourceReviewHash(fresh.resources) !== resourceReviewHash(inverse.resources)) {
        return conflict('A record changed or was replaced after the original update. No undo was applied.');
      }
    } else {
      const resource = fresh.resources[0];
      if (fresh.resources.length !== 1 || resource?.precondition.kind !== 'local_version'
        || resource.key !== inverse.key || resource.binding !== inverse.binding || resource.version !== inverse.version) {
        return conflict('The calendar event changed or its calendar was replaced. No undo was applied.');
      }
    }
    if (saved.public.resource_review.resources.length
      && resourceReviewHash(fresh.resources) !== resourceReviewHash(saved.public.resource_review.resources)) {
      return conflict('The reverse changes differ from your preview. Request a new review.');
    }
    return fresh;
  };
  const requireOwner = (origin: PreapprovalOrigin): Extract<PreapprovalOrigin, { mode: 'owner' }> => {
    if (origin.mode !== 'owner' || origin.entry !== 'owner_ui') throw new RpcError('local_undo_owner_required', 'Open undo in your paired webclient.', 403);
    return origin;
  };
  const result = (row: UndoRow): LocalUpdateUndoResult => {
    const receipt = row.status === 'completed' ? store.journal.find({ owner: 'local_undo', owner_ref: row.undo_id,
      attempt_id: row.undo_id, identity_hash: row.review_hash, operation: row.operation,
      kind: row.kind, review_hash: row.resource_review_hash }) : null;
    const link = receipt ? db.prepare('SELECT 1 FROM local_update_undo_links WHERE predecessor_receipt_id=? AND undo_receipt_id=? AND undo_id=?')
      .get(row.predecessor_receipt_id, receipt.receipt_id, row.undo_id) : null;
    return { undo_id: row.undo_id, predecessor_receipt_id: row.predecessor_receipt_id,
      status: row.status === 'pending' || row.status === 'dispatching' || (row.status === 'completed' && !link) ? 'unknown' : row.status,
      ...(receipt && link ? { local_receipt: { receipt_id: receipt.receipt_id, kind: receipt.kind, committed_at: receipt.committed_at } } : {}) };
  };
  return {
    prune,
    get(receiptId: string, origin: PreapprovalOrigin): LocalUpdateUndoResult | null {
      const owner = requireOwner(origin);
      // Prefer the committed link over a later decline of another old preview.
      // This read grants no authority and needs no expired private values.
      const row = db.prepare(`SELECT r.* FROM local_update_undo_reviews r
        LEFT JOIN local_update_undo_links l ON l.undo_id=r.undo_id AND l.predecessor_receipt_id=r.predecessor_receipt_id
        WHERE r.predecessor_receipt_id=? AND r.owner_id=? AND r.status<>'pending'
        ORDER BY (l.undo_id IS NOT NULL) DESC,r.decided_at DESC,r.created_at DESC,r.undo_id DESC LIMIT 1`)
        .get(receiptId, owner.owner_id) as UndoRow | undefined;
      return row ? result(row) : null;
    },
    async review(receiptId: string, origin: PreapprovalOrigin): Promise<LocalUpdateUndoReview> {
      const owner = requireOwner(origin);
      const material = await store.load(receiptId);
      const undo_id = 'undo_' + randomUUID(), epoch = store.clock.snapshot().epoch;
      const call = callFor(material.inverse);
      const saved: SealedReview = { ...material, call, origin: structuredClone(owner), epoch,
        public: { undo_id, predecessor_receipt_id: receiptId, review_hash: '', expires_at: Math.min(now() + 10 * 60_000, material.retained_until),
          resource_review: { schema_version: 1, operation: call.operation, input_hash: '', captured_at: now(), resources: [] } } };
      saved.public.resource_review = db.transaction(() => validate(saved)).immediate();
      saved.public.review_hash = localMutationHash(saved);
      const encrypted = await store.codec.seal(saved);
      db.transaction(() => {
        validate(saved);
        prune();
        db.prepare(`INSERT INTO local_update_undo_reviews
          (undo_id,predecessor_receipt_id,review_hash,epoch,expires_at,status,decision,encrypted,retained_until,worker_id,
          owner_id,credential_id,created_at,decided_at,operation,kind,resource_review_hash)
          VALUES(?,?,?,?,?,'pending',NULL,?,?,NULL,?,?,?,NULL,?,?,?)`)
          .run(undo_id, receiptId, saved.public.review_hash, epoch, saved.public.expires_at, encrypted, material.retained_until,
            owner.owner_id, owner.credential_id, now(), saved.public.resource_review.operation, saved.receipt.kind,
            localMutationHash(saved.public.resource_review));
      }).immediate();
      return saved.public;
    },
    async decide(args: LocalUpdateUndoDecision, origin: PreapprovalOrigin): Promise<LocalUpdateUndoResult> {
      const owner = requireOwner(origin);
      prune();
      const initial = rowFor(args.undo_id);
      if (!initial) return conflict('This undo review is unavailable.');
      if (initial.review_hash !== args.review_hash || initial.owner_id !== owner.owner_id || initial.credential_id !== owner.credential_id) {
        return conflict('This decision does not match your undo review.');
      }
      if (initial.status !== 'pending') {
        if (initial.decision !== args.decision) return conflict('This undo review already has a different decision.');
        return result(initial);
      }
      store.codec.assertUnlocked();
      if (!initial.encrypted) return conflict('The prior values for this undo expired. Its decision metadata and receipt links remain in the local audit.');
      const saved = await store.codec.open(initial.encrypted) as SealedReview;
      if (saved.public.undo_id !== args.undo_id || saved.public.review_hash !== args.review_hash
        || initial.review_hash !== args.review_hash || initial.predecessor_receipt_id !== saved.receipt.receipt_id
        || initial.epoch !== saved.epoch || initial.expires_at !== saved.public.expires_at || initial.retained_until !== saved.retained_until
        || initial.owner_id !== saved.origin.owner_id || initial.credential_id !== saved.origin.credential_id
        || initial.operation !== saved.public.resource_review.operation || initial.kind !== saved.receipt.kind
        || initial.resource_review_hash !== localMutationHash(saved.public.resource_review)
        || localMutationHash(origin) !== localMutationHash(saved.origin)) return conflict('This decision does not match your undo review.');
      const verifyClaim = (): UndoRow => {
        store.codec.assertUnlocked();
        const row = rowFor(args.undo_id);
        if (!row || row.encrypted !== initial.encrypted || row.review_hash !== args.review_hash || row.epoch !== store.clock.snapshot().epoch
          || row.operation !== initial.operation || row.kind !== initial.kind || row.resource_review_hash !== initial.resource_review_hash) {
          return conflict('This undo claim is no longer current.');
        }
        return row;
      };
      const claim = db.transaction(() => {
        const row = verifyClaim();
        if (row.status !== 'pending') {
          if (row.decision !== args.decision) return conflict('This undo review already has a different decision.');
          return false;
        }
        if (args.decision === 'approve') validate(saved);
        else {
          deps.validate(saved.origin, saved.call);
          if (saved.public.expires_at <= now()) return conflict('This undo review expired.');
        }
        deps.workers.assertCurrent(deps.workers.worker_id);
        db.prepare('UPDATE local_update_undo_reviews SET status=?,decision=?,worker_id=?,decided_at=? WHERE undo_id=?')
          .run(args.decision === 'approve' ? 'dispatching' : 'denied', args.decision, deps.workers.worker_id, now(), args.undo_id);
        return args.decision === 'approve';
      }).immediate();
      if (!claim) return result(verifyClaim());
      const call = callFor(saved.inverse); // reconstruct Calendar undefined removals after decrypt
      try {
        const review = saved.public.resource_review;
        await withLocalMutationScope({ record(connection, kind, actual) {
          const row = verifyClaim();
          if (connection !== db || !db.inTransaction || row.status !== 'dispatching' || row.decision !== 'approve'
            || row.worker_id !== deps.workers.worker_id
            || kind !== saved.receipt.kind || resourceReviewHash(actual) !== resourceReviewHash(review)) {
            return conflict('The reverse write no longer owns this approval.');
          }
          deps.workers.assertCurrent(deps.workers.worker_id);
          validate(saved, false);
          // Calendar's provider preparation is asynchronous; recheck the live
          // account binding under the final write lock as well as its row CAS.
          if (saved.inverse.kind === 'local_calendar') {
            const current = execution.executorConfig.resourceReview?.capture(call.slug, dispatchInput(saved))?.resources[0];
            if (current?.binding !== saved.inverse.binding || current.precondition.kind !== 'local_version') {
              return conflict('The local calendar binding changed before undo.');
            }
          }
          const receipt = store.journal.record({ owner: 'local_undo', owner_ref: args.undo_id,
            attempt_id: args.undo_id, identity_hash: args.review_hash, operation: review.operation, kind,
            review_hash: localMutationHash(review) });
          db.prepare('INSERT INTO local_update_undo_links VALUES(?,?,?)').run(saved.receipt.receipt_id, receipt.receipt_id, args.undo_id);
          db.prepare("UPDATE local_update_undo_reviews SET status='completed' WHERE undo_id=?").run(args.undo_id);
        } }, () => withResourceReview(review, () => {
          if (saved.inverse.kind === 'records') {
            if (!execution.recordsStore) throw new RpcError('local_undo_unavailable', 'Records is unavailable.', 503);
            return execution.recordsStore.execute({ binding: saved.inverse.binding, args: saved.inverse.args,
              principal: 'owner-undo:' + saved.origin.credential_id });
          }
          const dispatch = execution.executorConfig.kernelDispatchers?.calendarUpdate;
          if (!dispatch) throw new RpcError('local_undo_unavailable', 'The local calendar is unavailable.', 503);
          return dispatch({ slug: saved.inverse.slug, source_id: saved.inverse.source_id,
            patch: dispatchInput(saved).patch as Record<string, unknown> });
        }));
        if (verifyClaim().status !== 'completed') throw new Error('The reverse write produced no local receipt.');
      } catch (error) {
        const row = verifyClaim();
        if (row.status === 'completed') return result(row);
        db.prepare("UPDATE local_update_undo_reviews SET status='failed' WHERE undo_id=? AND status='dispatching'").run(args.undo_id);
        throw error;
      }
      return result(verifyClaim());
    },
  };
};
export type LocalUpdateUndo = ReturnType<typeof createLocalUpdateUndo>;
