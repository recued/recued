import type { WorkEntity } from '@recued/contracts';
import type { WorkEntityCrudRpcDeps } from './work-entity-crud-handler.js';

/** Display follows contact merges without rewriting the stored reference. */
export const commitmentCounterparties = (entities: readonly WorkEntity[], display: WorkEntityCrudRpcDeps['contactDisplay']): Record<string, string> => {
  const ids = new Set(entities.flatMap(entity => entity._kind === 'commitment' && entity.counterparty_contact_id ? [entity.counterparty_contact_id] : []));
  return Object.fromEntries([...ids].map(id => {
    const contact = display?.getByContactIdResolved(id);
    return [id, contact?.name?.trim() || contact?.email || 'Contact unavailable'];
  }));
};
