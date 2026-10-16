import type { CollectionInstanceRecord } from './instance-store.js';
import type { OAuthAccountStore } from './mail/oauth.js';

/** A borrowed source owns its grant; removal only reclaims this lane's cursors. */
export const purgeBorrowedOAuthCursors = async (row: CollectionInstanceRecord, store: OAuthAccountStore): Promise<void> => {
  const slug = typeof row.config.account_slug === 'string' ? row.config.account_slug : row.slug;
  const prefix = row.adapter_type + '.' + slug + '.';
  const ownNamespace = slug.startsWith(row.platform === 'mail' ? 'managed-mail:' : 'managed-calendar:');
  const isCursor = (key: string): boolean => key.startsWith(prefix) && (ownNamespace || (row.platform === 'mail'
    ? row.adapter_type === 'gmail' ? key === prefix + 'history_id' : key.startsWith(prefix + 'delta_link.')
    : key.startsWith(prefix + (row.adapter_type === 'gcal' ? 'sync_token.' : 'cal_delta_link.'))));
  if (store.getAll) {
    for (const key of Object.keys(await store.getAll())) if (isCursor(key)) await store.delete(key);
  } else if (row.platform === 'mail' && row.adapter_type === 'gmail') await store.delete(prefix + 'history_id');
};
