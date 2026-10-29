import { getKernelOp, kernelOpForBackingSlug, stripCorePrefix, type ExecutionSource, type SituationRef, type WorkEntity } from '@recued/contracts';
import { IngredientError } from '@recued/ingredients';
import type { SituationAccess } from './access.js';

/** What a scoped read strips from a work record: references to items outside the
 * contract's spheres, and a vendor's opaque extension, which may name unscoped
 * related records. A scoped subscriber's events carry the same (§4.5). */
export const scopeWorkFields = <T extends Record<string, unknown>>(row: T, allows: (ref: SituationRef) => boolean): T => {
  const value = structuredClone(row) as T & Record<string, unknown>;
  for (const field of ['counterparty_contact_id', 'assigned_contact_id', 'holder_contact']) {
    const id = value[field]; if (typeof id === 'string' && !allows({ collection: 'contact', id })) delete value[field];
  }
  for (const [field, collection] of [['parent_project_id', 'project'], ['belongs_to', 'asset']] as const) {
    const id = value[field]; if (typeof id === 'string' && !allows({ collection, id })) delete value[field];
  }
  for (const [field, collection] of [['related_contact_ids', 'contact'], ['related_project_ids', 'project']] as const) {
    const ids = value[field]; if (Array.isArray(ids)) (value as Record<string, unknown>)[field] = ids.filter(id => typeof id === 'string' && allows({ collection, id }));
  }
  delete value.source_extension_blob;
  return value;
};

export const SPHERE_READ_REFUSAL = 'This contract is restricted to selected spheres. This operation cannot enforce that boundary. Use situation.query for the permitted records, or ask the owner to change the contract. This is a permission refusal, not an empty result; do not retry this operation.';
export const createReadScope = (access: SituationAccess, source: ExecutionSource | undefined) => {
  const context = access.fence(source);
  const limited = !context.owner && !context.all_spheres;
  const allows = (ref: SituationRef): boolean => {
    if (!limited) return true;
    const sphere = context.referenceSphere?.(ref);
    return sphere !== undefined && context.spheres?.includes(sphere) === true;
  };
  const cleanWork = <T extends WorkEntity>(row: T): T =>
    limited ? scopeWorkFields(row as T & Record<string, unknown>, allows) : row;
  return { context, limited, allows, cleanWork };
};

/** Raw kernel readers that have no item predicate must not turn a restricted
 * contract back into a whole-collection read. Work and situation have adapters. */
export const assertKernelReadScope = (access: SituationAccess, slug: string, source: ExecutionSource | undefined): void => {
  const bare = stripCorePrefix(slug);
  const id = kernelOpForBackingSlug(bare); const op = id ? getKernelOp(id) : undefined;
  // CSV transforms write a new artifact but also read whole source files. The
  // write tier must not exempt that input read from a sphere restriction.
  if (bare.startsWith('csv-')) {
    if (createReadScope(access, source).limited) throw new IngredientError('INGREDIENT_SCOPE_INSUFFICIENT', SPHERE_READ_REFUSAL);
    return;
  }
  const sensitive = /^(?:email|mail|calendar|contact|file|memory|annotation|link|enrichment|work-entity|records|data)-/u.test(bare);
  if (!sensitive || (op && op.risk !== 'read') || ['work-entity-list', 'work-entity-get'].includes(bare)) return;
  if (createReadScope(access, source).limited) throw new IngredientError('INGREDIENT_SCOPE_INSUFFICIENT', SPHERE_READ_REFUSAL);
};
