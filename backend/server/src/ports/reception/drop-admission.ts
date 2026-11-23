import type { PublicEndpointRegistryStore } from '../../storage/public-endpoint-registry-store.js';
import type { DropBlobInsertInput, DropBlobInsertResult, DropBlobStore } from '../../storage/reception-drop-store.js';
import { parseDropLinkConfig } from './transformations/drop-link.js';

export class DropAdmissionError extends Error {
  constructor(readonly conflict: 'not_authorized' | 'day_cap') {
    super(`Drop admission refused: ${conflict}`);
  }
}

/** Both public upload transports use this commit boundary. CAS objects may be
 * shared; refused uploads leave their reclamation to the existing keep-set sweep. */
export const admitDropBlob = (deps: {
  readonly registry: PublicEndpointRegistryStore;
  readonly drops: DropBlobStore;
  readonly input: DropBlobInsertInput;
  readonly now: number;
  readonly authorize: () => boolean;
}): DropBlobInsertResult => deps.drops.insertIfAvailable({ ...deps.input, uploaded_at: deps.now }, {
  authorize: () => {
    if (deps.authorize() !== true) return null;
    const row = deps.registry.findById(deps.input.endpoint_id);
    if (!row || row.kind !== 'drop_link' || !row.enabled || row.revoked_at !== null
      || row.expires_at !== null && row.expires_at <= deps.now) return null;
    const config = parseDropLinkConfig(row.metadata);
    return config ? { max_uploads_per_endpoint_per_day: config.max_uploads_per_endpoint_per_day,
      one_time: config.link_kind === 'one_time' } : null;
  },
  window_start_at: deps.now - 86_400_000,
  consumeOneTime: () => {
    if (deps.registry.revoke({ endpoint_id: deps.input.endpoint_id, now: deps.now,
      reason: 'one_time_drop_consumed' }) !== 'revoked') {
      throw new Error('One-time drop consumption failed');
    }
  },
});
