import { RpcError, collectionPermissionScopes, isCollectionPermissionChoices,
  type CollectionPermissionChoices, type CollectionAuthenticationProvider, type ManagedOAuthAccountIdentity } from '@recued/contracts';
import { oauthScopesCover } from './managed-oauth-service.js';
import type { CollectionInstanceRecord } from './collections/instance-store.js';
import { getGrantedScopes, grantedScopesInclude, type HttpFetcher } from './collections/mail/oauth.js';
import type { MailEnrollDeps } from './collections/mail/enroll.js';
import type { CalendarEnrollDeps } from './collections/calendar/enroll.js';
import { collectionOAuthBinding } from './collection-oauth-sources.js';

export const collectionProvider = (row: CollectionInstanceRecord): CollectionAuthenticationProvider => {
  if (row.platform === 'mail' && ['gmail', 'graph'].includes(row.adapter_type)
    || row.platform === 'calendar' && ['gcal', 'graph'].includes(row.adapter_type)) return row.adapter_type as CollectionAuthenticationProvider;
  throw new RpcError('bad_request', 'Authentication switching is available for Google and Microsoft Mail and Calendar.');
};
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim().length > 0
  && value.length <= 2048 && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : undefined;
const email = (value: unknown): string | undefined => { const v = text(value); return v && /^[^\s@]+@[^\s@]+$/.test(v) ? v.toLowerCase() : undefined; };
export const collectionIdentityUrl = (row: Pick<CollectionInstanceRecord, 'platform' | 'adapter_type'>): string => row.adapter_type === 'gmail'
  ? 'https://gmail.googleapis.com/gmail/v1/users/me/profile' : row.adapter_type === 'gcal'
    ? 'https://www.googleapis.com/calendar/v3/calendars/primary' : row.platform === 'mail'
      ? 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox?$select=id,parentFolderId'
      : 'https://graph.microsoft.com/v1.0/me/calendar?$select=id,owner';
export const readCollectionIdentity = async (row: CollectionInstanceRecord, fetcher: HttpFetcher): Promise<ManagedOAuthAccountIdentity> => {
  const response = await fetcher(collectionIdentityUrl(row), { method: 'GET' });
  if (!response.ok) throw new RpcError('bad_request', 'The vendor account could not be verified. Repair authentication before switching.');
  const data = object(await response.json());
  let address = row.adapter_type === 'gmail' ? email(data.emailAddress) : row.adapter_type === 'gcal'
    ? email(data.id) : email(object(data.owner).address);
  const id = row.adapter_type === 'gmail' ? address : text(data.id);
  if (!id || row.adapter_type === 'gcal' && id === 'primary') throw new RpcError('bad_request', 'The vendor did not return a verifiable account identity. The collection was left unchanged.');
  if (row.adapter_type === 'graph' && row.platform === 'mail') {
    // Optional display metadata. Its absence never requests User.Read or weakens the Inbox proof.
    try {
      const profile = await fetcher('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', { method: 'GET' });
      if (profile.ok) { const value = object(await profile.json()); address = email(value.mail) ?? email(value.userPrincipalName); }
    } catch { /* Missing identity permission or profile stays Unknown. */ }
  }
  return { status: 'known', account_id: id, ...(address ? { email: address } : {}) };
};
export const matchingCollectionAccount = (a: ManagedOAuthAccountIdentity, b: ManagedOAuthAccountIdentity): boolean =>
  a.status === 'known' && b.status === 'known' && !!a.account_id && a.account_id === b.account_id;

export interface CollectionAbilities { send: boolean; mutation: boolean; write: boolean; needs: string[] }
export const collectionPermissionChoices = (row: CollectionInstanceRecord, abilities: CollectionAbilities): CollectionPermissionChoices =>
  row.platform === 'mail' ? { platform: 'mail', slug: row.slug, read: true, send: abilities.send, organize: abilities.mutation }
    : { platform: 'calendar', slug: row.slug, read: true, edit_events: abilities.write };

export const requestedCollectionAbilities = (row: CollectionInstanceRecord, current: CollectionAbilities, choice: unknown): CollectionAbilities => {
  if (choice === undefined) return current;
  if (!isCollectionPermissionChoices(choice) || choice.platform !== row.platform || choice.slug !== row.slug) {
    throw new RpcError('bad_request', 'Choose valid permissions for this Mail or Calendar account. Reading is required for sync.');
  }
  return { send: choice.platform === 'mail' && choice.send, mutation: choice.platform === 'mail' && choice.organize,
    write: choice.platform === 'calendar' && choice.edit_events, needs: collectionPermissionScopes(collectionProvider(row), choice) };
};

export const collectionPermissionCaps = (row: CollectionInstanceRecord, current: CollectionAbilities, abilities: CollectionAbilities): CollectionInstanceRecord['caps'] =>
  row.platform === 'calendar' && (!abilities.write || !current.write) ? { ...row.caps, create_event: abilities.write ? 'yes' : 'no', update_event: abilities.write ? 'yes' : 'no',
    delete_event: abilities.write ? 'yes' : 'no', rsvp: abilities.write ? 'yes' : 'no' } : row.caps;

export const collectionAbilities = async (row: CollectionInstanceRecord, deps: MailEnrollDeps | CalendarEnrollDeps): Promise<CollectionAbilities> => {
  const provider = collectionProvider(row); const bound = collectionOAuthBinding(row.config) !== undefined;
  const granted = bound ? [] : await getGrantedScopes(deps.accountStore, provider,
    typeof row.config.account_slug === 'string' ? row.config.account_slug : row.slug);
  // ⚠ `send` is the owner's CHOICE to send, read from the grant, not whether a
  // send would work: an Outlook grant from before 2026-10-15 holds `Mail.Send`
  // without the `Mail.ReadWrite` its draft needs. `needs` below asks for both, so
  // a reconnect or an app switch keeps the choice and mends the grant.
  const send = row.platform === 'mail' && (bound ? row.config.managed_send_enabled === true
    : row.config.native_send_enabled !== false && grantedScopesInclude(granted, provider === 'gmail' ? 'https://www.googleapis.com/auth/gmail.send' : 'Mail.Send'));
  const mutation = row.platform === 'mail' && (bound ? row.config.managed_mutation_enabled === true
    : row.config.native_mutation_enabled !== false && grantedScopesInclude(granted, provider === 'gmail' ? 'https://www.googleapis.com/auth/gmail.modify' : 'Mail.ReadWrite'));
  const caps = object(row.caps);
  const write = row.platform === 'calendar' && (bound ? row.config.managed_write_enabled === true
    : row.config.native_write_enabled !== false && ['create_event', 'update_event', 'delete_event', 'rsvp'].some(key => caps[key] === 'yes' || caps[key] === 'conditional'));
  const needs = collectionPermissionScopes(provider, collectionPermissionChoices(row, { send, mutation, write, needs: [] }));
  return { send, mutation, write, needs };
};
/** Only service-specific documented implications; requested permissions never count as grants. */
export const collectionScopesCover = (grants: readonly string[], needs: readonly string[]): boolean =>
  oauthScopesCover(needs.some(scope => scope.startsWith('https://www.googleapis.com/auth/'))
    ? 'https://www.googleapis.com' : 'https://graph.microsoft.com', grants, needs);

export const collectionSelections = (row: CollectionInstanceRecord): string[] => {
  const raw = row.config[row.platform === 'calendar' ? 'calendar_filter' : row.adapter_type === 'gmail' ? 'label_filter' : 'folder_filter'];
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 100 || raw.some(value => !text(value))) throw new RpcError('bad_request', 'The saved folder or calendar selection cannot be verified.');
  return [...new Set(raw)] as string[];
};
export const verifyCollectionReads = async (row: CollectionInstanceRecord, fetcher: HttpFetcher, grants: readonly string[] | null): Promise<void> => {
  const read = async (url: string): Promise<Record<string, unknown>> => {
    const response = await fetcher(url, { method: 'GET' });
    if (!response.ok) throw new RpcError('bad_request', 'The selected authentication cannot read the existing collection or its selected folders/calendars.');
    return object(await response.json());
  };
  const graphRead = (data: Record<string, unknown>, need: string): void => {
    // ReadBasic can successfully list IDs and subjects while omitting body.
    // Empty resources cannot demonstrate that stronger permission at all.
    if (!Array.isArray(data.value)) throw new RpcError('bad_request', 'The vendor did not return verifiable collection read data.');
    if (!data.value.length && (!grants || !collectionScopesCover(grants, [need]))) {
      throw new RpcError('bad_request', 'An empty collection needs vendor-reported full read permissions before switching authentication.');
    }
    for (const value of data.value) {
      const item = object(value);
      if (!text(item.id) || typeof object(item.body).content !== 'string') {
        throw new RpcError('bad_request', 'The selected authentication did not prove full body read access to the collection.');
      }
    }
  };
  const selected = collectionSelections(row);
  if (row.adapter_type === 'gmail') {
    for (const id of selected) await read('https://gmail.googleapis.com/gmail/v1/users/me/labels/' + encodeURIComponent(id));
    const data = await read('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1');
    const first = Array.isArray(data.messages) ? text(object(data.messages[0]).id) : undefined;
    if (first) await read('https://gmail.googleapis.com/gmail/v1/users/me/messages/' + encodeURIComponent(first) + '?format=full');
    else if (!grants || !collectionScopesCover(grants, ['https://www.googleapis.com/auth/gmail.readonly'])) {
      throw new RpcError('bad_request', 'An empty Gmail mailbox needs vendor-reported mail read permissions before switching authentication.');
    }
  } else if (row.platform === 'mail') {
    for (const id of selected) await read('https://graph.microsoft.com/v1.0/me/mailFolders/' + encodeURIComponent(id) + '?$select=id');
    graphRead(await read('https://graph.microsoft.com/v1.0/me/messages?$top=1&$select=id,body'), 'Mail.Read');
  } else {
    await read(row.adapter_type === 'gcal' ? 'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1'
      : 'https://graph.microsoft.com/v1.0/me/calendars?$top=1&$select=id');
    const base = row.adapter_type === 'gcal' ? 'https://www.googleapis.com/calendar/v3/calendars/' : 'https://graph.microsoft.com/v1.0/me/calendars/';
    for (const id of selected.length ? selected : [row.adapter_type === 'gcal' ? 'primary' : '__default__']) {
      if (id !== '__default__') await read(base + encodeURIComponent(id));
      const events = await read(id === '__default__' ? 'https://graph.microsoft.com/v1.0/me/calendar/events?$top=1&$select=id,body'
        : base + encodeURIComponent(id) + '/events?' + (row.adapter_type === 'gcal' ? 'maxResults=1' : '$top=1&$select=id,body'));
      if (row.adapter_type === 'graph') graphRead(events, 'Calendars.Read');
    }
  }
};
