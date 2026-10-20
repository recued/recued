import { kernelOpForBackingSlug, type ExecutionSource } from '@recued/contracts';
import type { SituationAccess } from './access.js';
import { buildVersionedContractSnapshot } from '../contract-snapshot-version.js';

/** A subscriber is no bearer. Its owner-selected contract grants the actual
 * kernel reads; selecting one creates neither a grant nor a standing approval. */
export const subscriberContractSnapshot = (input: {
  access: SituationAccess; source: ExecutionSource; contract_id: string; slugs: readonly string[];
  scope_restrictions: readonly string[]; now: number;
}) => {
  const context = input.access.context(input.source, null);
  const allowed_tools = input.slugs.filter(slug => {
    const op = kernelOpForBackingSlug(slug); return op !== undefined && context.grants.isVerbOpGranted(op);
  });
  return buildVersionedContractSnapshot({ contract_id: input.contract_id, allowed_tools, approval_required: [],
    ...(context.spheres !== undefined ? { read_spheres: context.spheres } : {}),
    scope_restrictions: input.scope_restrictions, max_risk_without_approval: 'read', resolved_at: input.now });
};
