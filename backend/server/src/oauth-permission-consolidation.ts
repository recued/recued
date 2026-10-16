/** D-322 §43 — passive permission inventory; cleanup previews never mutate consent. */
import { createHash } from 'node:crypto';
import { OAUTH_APP_ID, RpcError, savedOAuthAppIssuerForEndpoints, UNECHOED_AUTHORIZATION_SCOPES, isOAuthPermissionInventory,
  type ConnectionRow, type ManagedOAuthConnectionUse, type OAuthAppsResponse,
  type OAuthPermissionRequest, type OAuthPermissionInventory, type OAuthPermissionGroup, type OAuthPermissionNeeds,
  type OAuthPermissionRequirement, type OAuthPermissionCleanupPreview } from '@recued/contracts';
import type { OAuthAppConfigStore } from './oauth-app-config-store.js';
import type { CollectionInstanceStore, CollectionInstanceRecord } from './collections/instance-store.js';
import type { OAuthAccountStore } from './collections/mail/oauth.js';
import { decodeAuthFromStorage } from './connection-auth-storage.js';
import { collectionAbilities } from './collection-authentication-checks.js';
import { collectionOAuthBinding, collectionOAuthSourceName } from './collection-oauth-sources.js';
import { oauthScopesCover } from './managed-oauth-service.js';

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safe = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 2048 && !/[\x00-\x1f\x7f]/.test(v);
const scopes = (v: unknown): string[] | undefined => Array.isArray(v) && v.length <= 256 && v.every(s => safe(s) && !/\s/.test(s))
  ? [...new Set(v)].sort() : undefined;
const union = (...lists: readonly (readonly string[])[]): string[] => [...new Set(lists.flat())].sort();
const uniqueUses = (uses: readonly ManagedOAuthConnectionUse[]): ManagedOAuthConnectionUse[] => [...new Map(uses.map(u => [u.kind + ':' + u.id, u])).values()]
  .sort((a, b) => (a.kind + ':' + a.id).localeCompare(b.kind + ':' + b.id));
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const config = (row: ConnectionRow): Record<string, unknown> => { try { return object(JSON.parse(row.config_json)); } catch { return {}; } };
const grants = (row: ConnectionRow): string[] | undefined => { try { return scopes(JSON.parse(row.granted_scopes_json ?? 'null')); } catch { return; } };
const changed = () => new RpcError('conflict', 'Permissions or local dependencies changed. Refresh the permission inventory and review cleanup again.');
const fileNeeds = (row: ConnectionRow, uses: readonly ManagedOAuthConnectionUse[]): OAuthPermissionNeeds => {
  const files = uses.filter(u => u.kind === 'file'); if (!files.length) return { requirements: [], complete: true, warnings: [] };
  const c = config(row); let host = ''; try { host = new URL(String(c.base_url)).hostname; } catch { /* Unknown source. */ }
  let required: string[] | undefined;
  if (host === 'www.googleapis.com' && String(c.base_url).includes('/drive/')) required = ['https://www.googleapis.com/auth/drive.readonly'];
  if (host === 'graph.microsoft.com') required = c.vendor === 'sharepoint' ? ['Sites.Read.All', 'User.Read'] : ['Files.Read', 'User.Read'];
  if (host === 'api.dropboxapi.com') required = ['account_info.read', 'files.metadata.read', 'files.content.read'];
  return { requirements: (required ?? []).map(scope => ({ scope, uses: files })), complete: required !== undefined,
    warnings: required ? [] : ['This file source has no verified scope mapping. Keep its permissions until its requirements can be established.'] };
};
export const oauthPermissionScopeCovers = (issuer: OAuthPermissionGroup['issuer'], target: string, granted: string, required: string): boolean => {
  const graph = (scope: string) => scope.replace(/^https:\/\/graph\.microsoft\.com\//, '');
  const google = (scope: string) => 'https://www.googleapis.com/auth/' + scope;
  // Sheets accepts Drive grants; Graph file reads also accept Sites grants.
  // Keep these cross-resource alternatives local to the passive inventory.
  if (issuer === 'google' && (granted === google('drive') && ['drive.readonly', 'spreadsheets', 'spreadsheets.readonly'].some(s => required === google(s))
    || granted === google('drive.readonly') && required === google('spreadsheets.readonly'))) return true;
  if (issuer === 'microsoft' && (graph(granted) === 'Files.ReadWrite' && graph(required) === 'Files.Read'
    || graph(granted) === 'Sites.ReadWrite.All' && graph(required) === 'Sites.Read.All'
    || ['Sites.Read.All', 'Sites.ReadWrite.All'].includes(graph(granted)) && graph(required) === 'Files.Read')) return true;
  try { return oauthScopesCover(issuer === 'google' ? 'https://sheets.googleapis.com' : target, [granted], [required]); }
  catch { return granted === required; }
};
const understoodScope = (issuer: OAuthPermissionGroup['issuer'], scope: string): boolean => {
  if (issuer === 'google') return scope === 'https://mail.google.com/' || ['gmail.readonly', 'gmail.send', 'gmail.modify',
    'calendar', 'calendar.readonly', 'calendar.events', 'spreadsheets', 'spreadsheets.readonly', 'drive', 'drive.readonly']
    .some(name => scope === 'https://www.googleapis.com/auth/' + name);
  if (issuer === 'microsoft') return ['Mail.Read', 'Mail.ReadWrite', 'Mail.Send', 'Calendars.Read', 'Calendars.ReadWrite',
    'Files.Read', 'Files.ReadWrite', 'Sites.Read.All', 'Sites.ReadWrite.All', 'User.Read']
    .includes(scope.replace(/^https:\/\/graph\.microsoft\.com\//, ''));
  return false;
};
const protocolScope = (scope: string): boolean => UNECHOED_AUTHORIZATION_SCOPES.has(scope) || scope === '.default' || scope.endsWith('/.default');
interface Draft {
  group: OAuthPermissionGroup; requirements: OAuthPermissionRequirement[]; granted: string[]; requested: string[]; resource: string;
}
export interface OAuthPermissionService {
  /** Synchronous material check closes awaits between a review and its transaction. */
  signature?(): string;
  handle(request: OAuthPermissionRequest): Promise<Omit<OAuthAppsResponse, 'apps'>>;
}
export const createOAuthPermissionService = (deps: {
  apps: OAuthAppConfigStore; instances: CollectionInstanceStore; rows(): ConnectionRow[];
  accountStore?: OAuthAccountStore; key?: () => Uint8Array | null; now?(): number;
  connectionUses?(name: string): { uses: readonly ManagedOAuthConnectionUse[]; complete: boolean };
  requirements?(name: string): OAuthPermissionNeeds;
  nativeRequirements?(row: CollectionInstanceRecord): OAuthPermissionNeeds;
}): OAuthPermissionService => {
  const now = deps.now ?? Date.now;
  // Sync timestamps and backfill progress do not change authentication requirements.
  const signature = () => hash([deps.apps.listApps(), deps.instances.list().map(r => [r.platform, r.slug, r.adapter_type, r.created_at, r.config, r.caps,
    ['mail', 'calendar'].includes(r.platform) ? nativeExtras(r) : undefined]), deps.rows().map(r =>
    [r.kind, r.name, r.pk, r.enrolled_at, r.updated_at, r.auth_ciphertext, r.config_json, r.granted_scopes_json,
      r.kind === 'api' ? [references(r.name), need(r.name)] : undefined])]);
  const need = (name: string): OAuthPermissionNeeds => {
    try { return deps.requirements?.(name) ?? { requirements: [], complete: false, warnings: ['Local OAuth scope requirements are unavailable.'] }; }
    catch { return { requirements: [], complete: false, warnings: ['Local OAuth scope requirements could not be read.'] }; }
  };
  const references = (name: string) => {
    try { return deps.connectionUses?.(name) ?? { uses: [], complete: false }; }
    catch { return { uses: [], complete: false }; }
  };
  const nativeExtras = (row: CollectionInstanceRecord): OAuthPermissionNeeds => {
    try { return deps.nativeRequirements?.(row) ?? { requirements: [], complete: false, warnings: ['Saved native workflow requirements are unavailable.'] }; }
    catch { return { requirements: [], complete: false, warnings: ['Saved native workflow requirements could not be read.'] }; }
  };
  const nativeNeeds = async (row: CollectionInstanceRecord): Promise<OAuthPermissionRequirement[] | undefined> => {
    if (!deps.accountStore) return;
    try {
      const abilities = await collectionAbilities(row, { instances: deps.instances, accountStore: deps.accountStore });
      return abilities.needs.map(scope => ({ scope, uses: [{ kind: row.platform as 'mail' | 'calendar', id: row.slug, label: row.slug }] }));
    } catch { return; }
  };
  const addNativeRequirements = async (draft: Draft, row: CollectionInstanceRecord) => {
    const current = await nativeNeeds(row); const workflows = nativeExtras(row);
    if (current) draft.requirements.push(...current); else draft.group.requirements_complete = false;
    draft.requirements.push(...workflows.requirements); draft.group.requirements_complete &&= workflows.complete;
    draft.group.uses = uniqueUses([...draft.group.uses, ...workflows.uses ?? [], ...workflows.requirements.flatMap(r => r.uses)]);
    draft.group.warnings = union(draft.group.warnings, workflows.warnings);
  };
  const inventory = async (filter?: OAuthPermissionInventory['filter']): Promise<OAuthPermissionInventory> => {
    const selectedApp = filter ? deps.apps.getApp(filter.issuer, filter.app_id) : undefined;
    if (filter && !selectedApp) throw changed();
    const before = signature(); const unavailable: string[] = []; const groups = new Map<string, Draft>();
    const nativeEvidence = new Map<string, string | null>();
    const readNativeEvidence = async (key: string): Promise<string | null | undefined> => {
      const value = await deps.accountStore?.get(key);
      if (value !== undefined) {
        if (nativeEvidence.has(key) && nativeEvidence.get(key) !== value) throw changed();
        nativeEvidence.set(key, value);
      }
      return value;
    };
    const rows = deps.rows().filter(r => r.kind === 'api'); const instances = deps.instances.list();
    const decoded = await Promise.all(rows.map(async row => {
      try { return { row, auth: await decodeAuthFromStorage(row.auth_ciphertext, row, deps.key) }; }
      catch { unavailable.push('API credentials unavailable: ' + row.name); return { row, auth: undefined }; }
    }));
    const add = (key: unknown, app: Pick<OAuthPermissionGroup, 'app_key' | 'app_label' | 'issuer' | 'saved_app_id' | 'client_id'>,
      authentication: OAuthPermissionGroup['authentication'], resource: string): Draft => {
      const id = hash(key); const existing = groups.get(id); if (existing) return existing;
      const draft: Draft = { resource, requirements: [], granted: [], requested: [], group: { id, ...app, authentication,
        account_label: 'Unknown account', connection_names: [], native_accounts: [], uses: [], requirements_complete: true,
        grants_known: true, scopes: [], required_scopes: [], warnings: [] } };
      groups.set(id, draft); return draft;
    };
    for (const { row, auth } of decoded) {
      if (!auth || auth.type !== 'oauth2_refresh' && auth.type !== 'managed_oauth') continue;
      const c = config(row); const resource = typeof c.base_url === 'string' ? c.base_url : 'https://example.invalid';
      const issuer = auth.type === 'oauth2_refresh' ? savedOAuthAppIssuerForEndpoints(auth) ?? 'other'
        : /(^|\.)googleapis\.com$/.test((() => { try { return new URL(resource).hostname; } catch { return ''; } })()) ? 'google'
          : resource.startsWith('https://graph.microsoft.com/') ? 'microsoft' : 'other';
      const saved = auth.type === 'oauth2_refresh' && auth.saved_oauth_app ? deps.apps.getApp(auth.saved_oauth_app.issuer, auth.saved_oauth_app.id) : null;
      const direct = auth.type === 'oauth2_refresh';
      const appKey = direct ? hash([issuer, auth.client_id]) : hash(['broker', auth.broker_profile_id, auth.integration_id]);
      if (filter && (auth.type !== 'oauth2_refresh' || issuer !== filter.issuer || selectedApp?.client_id !== auth.client_id)) continue;
      const group = add(direct ? ['direct', appKey, auth.native_credential_id ?? ['connection', row.name]]
        : ['broker', auth.broker_profile_id, auth.integration_id, auth.connection_id], {
        app_key: appKey, issuer, app_label: direct ? saved?.label ?? (issuer === 'other' ? 'Custom OAuth app' : issuer === 'google' ? 'Google OAuth app' : 'Microsoft OAuth app')
          : 'Nango integration · ' + auth.integration_id,
        ...(direct ? { client_id: auth.client_id } : {}), ...(auth.type === 'oauth2_refresh' && saved && saved.client_id === auth.client_id ? { saved_app_id: saved.id } : {}) },
        direct ? 'direct_oauth' : 'broker', resource);
      group.group.connection_names = union(group.group.connection_names, [row.name]);
      group.group.api_resources = [...group.group.api_resources ?? [], { name: row.name, base_url: resource }].sort((a, b) => a.name.localeCompare(b.name));
      const uses = references(row.name); const needs = need(row.name); group.requirements.push(...needs.requirements);
      const files = fileNeeds(row, uses.uses); group.requirements.push(...files.requirements);
      group.group.uses = uniqueUses([...group.group.uses, ...uses.uses]);
      group.group.requirements_complete &&= uses.complete && needs.complete && files.complete;
      group.group.warnings = union(group.group.warnings, needs.warnings, files.warnings);
      const reported = grants(row); group.group.grants_known &&= reported !== undefined;
      group.granted = union(group.granted, reported ?? []);
      group.requested = union(group.requested, auth.type === 'managed_oauth' ? auth.requested_scopes : auth.required_scopes ?? []);
    }
    for (const row of instances) {
      if (!['mail', 'calendar'].includes(row.platform) || !['gmail', 'gcal', 'graph'].includes(row.adapter_type)) continue;
      if (collectionOAuthBinding(row.config) !== undefined) {
        const name = collectionOAuthSourceName(row.config); const group = [...groups.values()].find(g => name && g.group.connection_names.includes(name));
        if (group) {
          await addNativeRequirements(group, row);
          group.group.uses = uniqueUses([...group.group.uses, { kind: row.platform as 'mail' | 'calendar', id: row.slug, label: row.slug }]);
        } else if (!filter) unavailable.push('Collection authentication unavailable: ' + row.platform + ' ' + row.slug);
        continue;
      }
      const issuer = row.adapter_type === 'graph' ? 'microsoft' : 'google';
      const appId = safe(row.config.oauth_app_id) ? row.config.oauth_app_id : 'default'; const app = deps.apps.getApp(issuer, appId);
      // Two locally saved profiles can point at the same vendor app. A filtered
      // review must retain both profiles' needs before suggesting any cleanup.
      if (filter && (issuer !== filter.issuer || app?.client_id !== selectedApp?.client_id)) continue;
      const grantSlug = safe(row.config.account_slug) ? row.config.account_slug : row.slug; const prefix = row.adapter_type + '.' + grantSlug;
      const appKey = hash(app ? [issuer, app.client_id] : [issuer, 'missing-app', appId]);
      const group = add(['native', appKey, prefix], { issuer, app_key: appKey, app_label: app?.label ?? 'Missing saved OAuth app', saved_app_id: appId,
        ...(app ? { client_id: app.client_id } : {}) }, 'direct_oauth', issuer === 'google' ? 'https://sheets.googleapis.com' : 'https://graph.microsoft.com');
      group.group.native_accounts = [...group.group.native_accounts, { platform: row.platform as 'mail' | 'calendar', slug: row.slug }];
      const use: ManagedOAuthConnectionUse = { kind: row.platform as 'mail' | 'calendar', id: row.slug, label: row.slug };
      group.group.uses = uniqueUses([...group.group.uses, use]);
      if (safe(row.config.account_email)) group.group.account_label = row.config.account_email;
      let reported: string[] | undefined;
      try {
        const raw = await readNativeEvidence(prefix + '.granted_scopes');
        await readNativeEvidence(prefix + '.grant_generation');
        if (raw !== undefined && raw !== null) reported = scopes(raw.split(/\s+/).filter(Boolean));
      }
      catch (error) {
        if (error instanceof RpcError && error.code === 'conflict') throw error;
        // Locked or absent grant metadata remains unknown.
      }
      await addNativeRequirements(group, row);
      group.requirements.push(...(issuer === 'microsoft' ? ['User.Read', 'offline_access'] : ['email'])
        .map(scope => ({ scope, uses: [use] })));
      group.group.grants_known &&= reported !== undefined; group.granted = union(group.granted, reported ?? []);
      if (!app) group.group.requirements_complete = false;
    }
    for (const [key, value] of nativeEvidence) if (await deps.accountStore?.get(key) !== value) throw changed();
    if (signature() !== before) throw changed();
    for (const draft of groups.values()) {
      if (unavailable.length) draft.group.requirements_complete = false;
      const related = [...groups.values()].filter(other => other !== draft && other.group.app_key === draft.group.app_key);
      if (related.some(other => !other.group.requirements_complete)) draft.group.requirements_complete = false;
      draft.group.required_scopes = union(draft.requirements.map(r => r.scope));
      draft.group.scopes = union(draft.granted, draft.requested, draft.group.required_scopes).map(scope => {
        const requiredBy = uniqueUses(draft.requirements.filter(r => oauthPermissionScopeCovers(draft.group.issuer, draft.resource, scope, r.scope)).flatMap(r => r.uses));
        const relatedBy = uniqueUses(related.flatMap(other => other.requirements)
          .filter(r => oauthPermissionScopeCovers(draft.group.issuer, draft.resource, scope, r.scope)).flatMap(r => r.uses));
        const allRequirements = [...draft.requirements, ...related.flatMap(other => other.requirements)];
        // Knowing the grant's name alone does not establish its relationship
        // with a narrower scope outside our closed implication vocabulary.
        const relationshipKnown = allRequirements.length === 0 || understoodScope(draft.group.issuer, scope)
          && allRequirements.every(r => understoodScope(draft.group.issuer, r.scope) || UNECHOED_AUTHORIZATION_SCOPES.has(r.scope));
        return { scope, status: requiredBy.length ? 'required' as const : !relatedBy.length && !protocolScope(scope) && relationshipKnown && draft.group.requirements_complete && draft.group.grants_known && draft.granted.includes(scope)
          ? 'unused_locally' as const : 'unknown' as const,
        evidence: draft.granted.includes(scope) ? 'recorded_grant' as const : draft.requested.includes(scope) ? 'requested_only' as const : 'requirement_only' as const,
        required_by: requiredBy.length ? requiredBy : relatedBy };
      });
      if (draft.group.scopes.some(s => s.status === 'unknown' && s.required_by.length)) draft.group.warnings = union(draft.group.warnings,
        ['Another authorization using this OAuth app still needs some of these permissions. Shared consent cannot be ruled out, so those permissions are protected from cleanup.']);
      if (!draft.group.grants_known) draft.group.warnings = union(draft.group.warnings, ['The vendor-granted permission list is unavailable or incomplete. Requests are not proof of consent.']);
      if (!draft.group.requirements_complete) draft.group.warnings = union(draft.group.warnings, ['Some local dependencies are unresolved. Cleanup recommendations are unavailable for this authorization.']);
      if (draft.group.authentication === 'broker') draft.group.warnings = union(draft.group.warnings, ['Broker integrations are listed separately. Matching app or account identities across broker profiles have not been established.']);
    }
    const ordered = [...groups.values()].map(d => d.group).sort((a, b) => a.app_key.localeCompare(b.app_key) || a.id.localeCompare(b.id));
    if (ordered.length > 512 || unavailable.length > 256 || ordered.some(g => g.scopes.length > 512 || g.required_scopes.length > 256 || g.connection_names.length > 256)) {
      throw new RpcError('bad_request', 'This permission inventory is too large. Review one saved OAuth app at a time.');
    }
    const data = { groups: ordered, unavailable: [...new Set(unavailable)].sort(), ...(filter ? { filter } : {}) };
    const result = { ...data, fingerprint: hash([before, [...nativeEvidence].sort(([a], [b]) => a.localeCompare(b)), data]), observed_at: now() };
    if (!isOAuthPermissionInventory(result)) throw new RpcError('internal', 'Permission metadata could not be represented safely. Refresh or repair the listed dependencies.');
    return result;
  };
  return { signature, async handle(request) {
    if (request.action === 'permission_inventory') {
      if ((request.issuer === undefined) !== (request.app_id === undefined) || request.issuer !== undefined && !['google', 'microsoft'].includes(request.issuer)
        || request.app_id !== undefined && !OAUTH_APP_ID.test(request.app_id)) throw new RpcError('bad_request', 'Choose a saved OAuth app or review all permissions.');
      const filter = request.issuer && request.app_id ? { issuer: request.issuer, app_id: request.app_id } : undefined;
      if (filter && !deps.apps.getApp(filter.issuer, filter.app_id)) throw changed();
      return { action: request.action, permission_inventory: await inventory(filter) };
    }
    if (request.action !== 'preview_permission_cleanup' || !/^[a-f0-9]{64}$/.test(request.inventory_fingerprint)
      || !/^[a-f0-9]{64}$/.test(request.group_id) || !scopes(request.selected_scopes)?.length
      || new Set(request.selected_scopes).size !== request.selected_scopes.length) throw new RpcError('bad_request', 'Choose unused permissions from the current inventory.');
    // Re-read dependencies instead of trusting browser-supplied scope classifications.
    if (request.filter && (!['google', 'microsoft'].includes(request.filter.issuer) || !OAUTH_APP_ID.test(request.filter.app_id))) throw changed();
    const current = await inventory(request.filter);
    if (current.fingerprint !== request.inventory_fingerprint) throw changed();
    const selected = current.groups.find(g => g.id === request.group_id);
    if (!selected || request.selected_scopes.some(scope => !selected.scopes.some(s => s.scope === scope && s.status === 'unused_locally'))) {
      throw new RpcError('bad_request', 'Required or unconfirmed permissions cannot be selected for cleanup.');
    }
    const preview: OAuthPermissionCleanupPreview = { inventory_fingerprint: current.fingerprint, group_id: selected.id,
      selected_scopes: [...request.selected_scopes].sort(), retained_scopes: selected.scopes.filter(s => s.evidence === 'recorded_grant' && !request.selected_scopes.includes(s.scope)).map(s => s.scope),
      required_scopes: selected.required_scopes, connection_names: selected.connection_names, uses: selected.uses,
      related_group_ids: current.groups.filter(g => g.id !== selected.id && g.app_key === selected.app_key).map(g => g.id),
      method: selected.issuer === 'google' ? 'google_revoke_reconnect' : selected.issuer === 'microsoft' ? 'microsoft_consent_review' : 'vendor_consent_review',
      warnings: ['This is a cleanup preview. No provider permissions, credentials or scope history have changed.',
        'Usage covers this Recued instance. Other tools may still need these permissions.',
        ...(selected.issuer === 'google' ? ['Google revocation can remove the whole combined authorization. A guided reset must reconnect all affected uses with the remaining permissions.']
          : selected.issuer === 'microsoft' ? ['Selective Microsoft grant changes require supported organizational roles and elevated permissions. Personal accounts need vendor consent management.']
            : ['Review the vendor’s consent controls. Requesting fewer scopes or deleting a broker connection does not prove that prior consent was removed.']),
        'After cleanup, Recued must verify and retain the reduced permissions so a later sign-in does not request removed access again.'], mutation: false, verification: 'not_checked' };
    return { action: request.action, permission_cleanup: preview };
  } };
};
