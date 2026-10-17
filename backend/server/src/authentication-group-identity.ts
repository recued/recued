/** Shared passive identities: history must use the same keys as authentication repairs. */
import type { ConnectionAuth, ConnectionRow } from '@recued/contracts';
import type { CollectionInstanceRecord } from './collections/instance-store.js';

export const authenticationConnectionGroupKey = (row: Pick<ConnectionRow, 'pk' | 'enrolled_at'>, auth: ConnectionAuth | undefined): string =>
  JSON.stringify(auth?.type === 'managed_oauth' ? ['broker', auth.broker_profile_id, auth.integration_id, auth.connection_id]
    : auth?.type === 'oauth2_refresh' && auth.native_credential_id ? ['native', auth.native_credential_id]
    : ['connection', row.pk, row.enrolled_at]);

export const authenticationCollectionGroupKey = (row: Pick<CollectionInstanceRecord, 'adapter_type' | 'platform' | 'slug' | 'config'>): string => {
  const value = row.config.account_slug;
  const grant = typeof value === 'string' && value.trim() && value.length <= 2048 && !/[\x00-\x1f\x7f]/.test(value) ? value : row.slug;
  return JSON.stringify(['collection', row.adapter_type, grant,
    ['gmail', 'gcal', 'graph'].includes(row.adapter_type) ? row.config.oauth_app_id ?? 'default' : row.platform]);
};
