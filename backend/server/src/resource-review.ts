import { calendarChatUpdateInput } from './collections/calendar/chat-update-input.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { canonicalJSONStringify, sha256Hex } from '@recued/crypto';
import {
  RpcError, RecordsContractError, isResourceReview, isRecordsExecutionBinding,
  type IngredientManifest, type ResourceReview, type ResourceReviewHooks,
  type ReviewedResource,
} from '@recued/contracts';
import type { RecordsStore } from './records/store.js';

export const resourceReviewHash = (value: unknown): string =>
  sha256Hex(canonicalJSONStringify(JSON.parse(JSON.stringify(value))));

const reviews = new AsyncLocalStorage<ResourceReview | undefined>();
export const currentResourceReview = (): ResourceReview | undefined => reviews.getStore();
export const withResourceReview = <T>(review: ResourceReview | undefined, effect: () => T): T =>
  reviews.run(review, effect);

export const resourceConflict = (message: string, reviewed?: ResourceReview): never => {
  throw new RpcError('resource_conflict',
    message + ' No change was applied. Refresh the data and request a new review.', 409,
    undefined, reviewed ? { reviewed_operation: reviewed.operation } : undefined);
};

export const assertReviewedResource = (current: ReviewedResource): ReviewedResource | undefined => {
  const review = currentResourceReview();
  if (!review) return undefined;
  const pinned = review.resources.find(r => r.kind === current.kind && r.key === current.key);
  if (!pinned || pinned.binding !== current.binding || pinned.version !== current.version
    || resourceReviewHash(pinned.precondition) !== resourceReviewHash(current.precondition)
    || resourceReviewHash(pinned.after) !== resourceReviewHash(current.after)) {
    resourceConflict('The resource changed after it was reviewed.', review);
  }
  return pinned;
};

export const createResourceReviewHooks = (deps: {
  manifest(slug: string): IngredientManifest | undefined;
  calendar?: (operation: 'calendar-update' | 'calendar-delete', input: Record<string, unknown>) => ReviewedResource;
  records?: RecordsStore;
  now?: () => number;
}): ResourceReviewHooks => ({
  capture(slug, input, approved, resuming) {
    if (approved && !isResourceReview(approved)) resourceConflict('The saved resource review is invalid. Request a new review.');
    if (slug === 'calendar.update') {
      slug = 'calendar-update';
      input = calendarChatUpdateInput(input);
    }
    if ((slug === 'calendar-update' || slug === 'calendar-delete') && input.scope == null) {
      // The semantic dispatch omits an unset optional scope. Preparation may
      // still carry its null manifest default; both name this one occurrence.
      const { scope: _scope, ...normalized } = input;
      input = normalized;
    }
    let resources: ReviewedResource[] = [];
    let operation = slug;
    if ((slug === 'calendar-update' || slug === 'calendar-delete') && deps.calendar) {
      resources = [deps.calendar(slug, input)];
    } else {
      const key = typeof input.operation === 'string' ? input.operation : '';
      const manifest = deps.manifest(slug);
      const binding = manifest?.surfaces?.records?.executes?.[key];
      if (!deps.records || !isRecordsExecutionBinding(binding)
        || !['update', 'delete', 'upsert', 'batch'].includes(binding.action)) return undefined;
      const args = input.args as Record<string, unknown>;
      if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
      operation = manifest!.operations![key]!.operation_id;
      try { resources = deps.records.reviewMutation(binding, args, approved?.resources); }
      catch (error) {
        if (error instanceof RecordsContractError && (error.code === 'records_conflict' || error.code === 'records_not_found')) {
          resourceConflict('The proposed record revision is already out of date.', approved);
        }
        throw error;
      }
    }
    if (resources.length === 0) return undefined;
    const fresh: ResourceReview = { schema_version: 1, operation,
      input_hash: resourceReviewHash(input), captured_at: (deps.now ?? Date.now)(), resources };
    if (Buffer.byteLength(JSON.stringify(fresh), 'utf8') > 64 * 1024) {
      throw new RpcError('resource_review_too_large', 'This change is too large to review safely. Use a smaller change.', 400);
    }
    if (approved) {
      if (!isResourceReview(approved) || approved.operation !== operation
        || approved.input_hash !== fresh.input_hash
        || resourceReviewHash(approved.resources) !== resourceReviewHash(resources)) {
        resourceConflict('The proposed action or its resource changed after review.', approved);
      }
      return structuredClone(approved);
    }
    if (resuming) resourceConflict('This older approval has no resource version. It needs a fresh review.');
    return fresh;
  },
  run: withResourceReview,
});
