import { isRecordsExecutionBinding, kernelOpForBackingSlug, RpcError, type IngredientManifest } from '@recued/contracts';
import type { ManifestRegistry } from './manifest-loader.js';
import type { LocalUpdateInverse } from './local-update-undo-context.js';
import { localMutationHash } from './storage/ordinary-local-mutation-receipts.js';
import { resourceReviewHash } from './resource-review.js';

export interface LocalUpdateCall { slug: string; input: Record<string, unknown>; operation: string; manifest_hash: string }
export const inverseLocalUpdateCall = (inverse: LocalUpdateInverse, manifests: ManifestRegistry): LocalUpdateCall => {
  const conflict = (detail: string): never => { throw new RpcError('local_undo_conflict', detail, 409); };
  const manifest = (slug: string): IngredientManifest => {
    const value = manifests.get(slug);
    if (!value) return conflict('The operation is no longer installed.');
    return value;
  };
  const callFor = (): LocalUpdateCall => {
    if (inverse.kind === 'local_calendar') {
      return { slug: 'calendar-update', input: { slug: inverse.slug, source_id: inverse.source_id, patch: inverse.set },
        operation: kernelOpForBackingSlug('calendar-update')!, manifest_hash: localMutationHash(manifest('calendar-update')) };
    }
    const candidates: LocalUpdateCall[] = [];
    for (const slug of manifests.slugs()) {
      const value = manifest(slug);
      for (const [key, binding] of Object.entries(value.surfaces?.records?.executes ?? {})) {
        if (isRecordsExecutionBinding(binding) && resourceReviewHash(binding) === resourceReviewHash(inverse.binding)
          && value.operations?.[key]) candidates.push({ slug, input: { operation: key, args: inverse.args },
          operation: value.operations[key]!.operation_id, manifest_hash: localMutationHash(value) });
      }
    }
    if (candidates.length !== 1) return conflict('The original Records operation changed or is unavailable.');
    return candidates[0]!;
  };
  return callFor();
};

export const localUpdateInput = (call: LocalUpdateCall, inverse?: LocalUpdateInverse): Record<string, unknown> => {
  if (inverse?.kind !== 'local_calendar') return call.input;
  return { ...call.input, patch: Object.fromEntries([...Object.entries(inverse.set), ...inverse.unset.map(key => [key, undefined])]) };
};
