import { canonicalizeEmail, RpcError, type WorkEntityLinkedFromRpcRequest, type WorkEntityLinkedFromRpcResponse } from '@recued/contracts';
import type { WorkEntityCrudRpcDeps } from './work-entity-crud-handler.js';

/** Resolve the complete stored identity group on every read. Names never enter
 * this lookup; a split or alias withdrawal takes effect without reindexing. */
export const contactLinkedFromTarget = (
  store: WorkEntityCrudRpcDeps['contactDisplay'], reference: string,
  expected: WorkEntityLinkedFromRpcRequest['contact_identity'],
): NonNullable<WorkEntityLinkedFromRpcResponse['contact_target']> => {
  if (!store?.get || !store.resolveCanonicalEmail || !store.resolvedContactIds || !store.addressSet) {
    throw new RpcError('not_configured', 'Contact links cannot be read here.');
  }
  const byId = store.getByContactIdResolved(reference);
  const email = byId?.email ?? (canonicalizeEmail(reference) ? store.resolveCanonicalEmail(reference).canonical_email : undefined);
  const contact = email ? store.get(email) : null;
  if (!contact?.contact_id || contact.merged_into !== undefined) throw new RpcError('not_found', 'This contact is no longer available.');
  if (!expected || expected.id !== contact.contact_id || expected.created_at !== contact.created_at) {
    throw new RpcError('conflict', 'This contact changed. Reopen the contact before reading its links.');
  }
  return { id: contact.contact_id, created_at: contact.created_at,
    reference_ids: [...new Set([contact.contact_id, ...store.resolvedContactIds(contact.contact_id),
      ...store.addressSet(contact.email).map(value => canonicalizeEmail(value) || value)])] };
};
