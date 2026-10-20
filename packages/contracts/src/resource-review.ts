import { RpcError } from './rpc/types.js';

/** Owner review of a mutation's exact resource versions. These snapshots are
 * host-authored evidence, never an approval supplied in tool arguments. */
export interface ReviewedResource {
  kind: 'calendar' | 'records';
  key: string;
  label: string;
  /** Includes the account/namespace incarnation and dispatch binding. */
  binding: string;
  /** Changes even if an edit is subsequently undone. */
  version: string;
  precondition:
    | { kind: 'etag'; value: string }
    | { kind: 'local_version'; value: string }
    | { kind: 'records_revision'; value: number; incarnation: string }
    | { kind: 'records_absent'; generated_for?: number };
  before: Record<string, unknown>;
  after: Record<string, unknown> | null;
  /** Ordered batch effects, including intermediate edits that a net diff
   * would hide. Indexes refer to the original zero-based ops array. */
  changes?: {
    operation_index: number;
    action: 'create' | 'update' | 'upsert' | 'delete';
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  }[];
}

export interface ResourceReview {
  schema_version: 1;
  operation: string;
  input_hash: string;
  captured_at: number;
  resources: ReviewedResource[];
}

/** Content-free proof that a built-in local mutation and its receipt shared
 * one transaction. This is inspection data, never an execution permit. */
export interface LocalMutationReceiptSummary {
  receipt_id: string;
  kind: 'records' | 'local_calendar';
  committed_at: number;
}
export const isLocalMutationReceiptSummary = (value: unknown): value is LocalMutationReceiptSummary => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.receipt_id === 'string' && /^lmr_[a-f0-9-]{36}$/.test(row.receipt_id)
    && (row.kind === 'records' || row.kind === 'local_calendar')
    && Number.isSafeInteger(row.committed_at) && Number(row.committed_at) >= 0;
};

/** Host-injected dispatch participation. Authored recipes and wire requests
 * cannot provide this callback or turn inspection data into authority. */
export interface LocalMutationHooks {
  run<T>(call: { slug: string; operation: string; input: Record<string, unknown>; review: ResourceReview;
    stepMeta?: import('./steps.js').StepMeta; commit?: import('./commits.js').Commit;
    /** Opaque host reservation, checked only at the final write boundary. */
    authority_reservation?: object },
  dispatch: () => T | Promise<T>): Promise<T>;
}

/** Host callbacks shared by the ingredient and catalog approval boundaries. */
export interface ResourceReviewHooks {
  capture(slug: string, input: Record<string, unknown>, approved?: ResourceReview,
    resuming?: boolean): ResourceReview | undefined;
  run<T>(review: ResourceReview | undefined, effect: () => T): T;
}

/** An optional integration may skip unsupported fresh calls, but it must
 * never discard evidence retained by an earlier approval. */
export const captureResourceReview = (hooks: ResourceReviewHooks | undefined,
  slug: string, input: Record<string, unknown>, approved?: ResourceReview,
  resuming?: boolean): ResourceReview | undefined => {
  const review = hooks?.capture(slug, input, approved, resuming);
  if (approved && !review) throw new RpcError('resource_conflict',
    'The saved resource review cannot be verified on this host. No change was applied. Restore the integration and request a new review.', 409);
  return review;
};

const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

export const isResourceReview = (value: unknown): value is ResourceReview => {
  if (!object(value) || value.schema_version !== 1
    || typeof value.operation !== 'string' || typeof value.input_hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.input_hash)
    || typeof value.captured_at !== 'number' || !Number.isFinite(value.captured_at)
    || !Array.isArray(value.resources) || value.resources.length < 1 || value.resources.length > 100) return false;
  return value.resources.every((r: unknown) => object(r)
    && (r.kind === 'calendar' || r.kind === 'records')
    && ['key', 'label', 'binding', 'version'].every(k => typeof r[k] === 'string' && r[k] !== '')
    && object(r.before) && (r.after === null || object(r.after))
    && (r.changes === undefined || (r.kind === 'records' && Array.isArray(r.changes)
      && r.changes.length > 0 && r.changes.length <= 100 && r.changes.every((change: unknown) =>
        object(change) && Number.isSafeInteger(change.operation_index)
        && Number(change.operation_index) >= 0 && Number(change.operation_index) < 100
        && typeof change.action === 'string' && ['create', 'update', 'upsert', 'delete'].includes(change.action)
        && (change.before === null || object(change.before)) && (change.after === null || object(change.after)))))
    && object(r.precondition)
    && (r.precondition.kind === 'records_absent'
      ? r.kind === 'records' && Object.keys(r.before).length === 0
        && (r.precondition.generated_for === undefined || (Number.isSafeInteger(r.precondition.generated_for)
          && Number(r.precondition.generated_for) >= 0 && Number(r.precondition.generated_for) < 100))
      : r.precondition.kind === 'records_revision'
      ? Number.isSafeInteger(r.precondition.value) && Number(r.precondition.value) >= 0
        && typeof r.precondition.incarnation === 'string' && r.precondition.incarnation !== ''
      : (r.precondition.kind === 'etag' || r.precondition.kind === 'local_version')
        && typeof r.precondition.value === 'string' && r.precondition.value !== ''
        && r.precondition.value !== '*'));
};

/** The same evidence is rendered on a first hold and after restart recovery. */
const displaySnapshot = (resource: ReviewedResource, value: Record<string, unknown>): string =>
  JSON.stringify(Object.fromEntries(Object.entries(value).map(([key, cell]) => {
    if (resource.kind === 'calendar' && (key === 'start_at' || key === 'end_at')
      && typeof cell === 'number' && Number.isFinite(cell) && Math.abs(cell) <= 8.64e15) {
      return [key, new Date(cell).toISOString()];
    }
    return [key, cell];
  })), null, 2);

export const renderResourceReview = (review: ResourceReview): string =>
  'Reviewed data (changes require a fresh review):\n' + review.resources.map(r =>
    r.label + '\nVersion: ' + r.version + '\nBefore: '
    + (r.precondition.kind === 'records_absent' ? 'Does not exist' : displaySnapshot(r, r.before))
    + '\nAfter: ' + (r.after === null
      ? r.precondition.kind === 'records_absent' ? 'Does not exist' : 'Delete this resource'
      : displaySnapshot(r, r.after))
    + (r.changes ? '\nBatch operations:\n' + r.changes.map(change =>
      String(change.operation_index + 1) + '. ' + change.action
      + '\n  Before: ' + (change.before === null ? 'Does not exist' : displaySnapshot(r, change.before))
      + '\n  After: ' + (change.after === null ? 'Does not exist' : displaySnapshot(r, change.after))).join('\n') : '')).join('\n\n');
