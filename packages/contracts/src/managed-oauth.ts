import { isFileSourceAuthenticationPreview } from './file-source-authentication.js';
/** D-322 — broker setup and authorization. No broker key enters a connection view. */
import type { BulkPackManifest } from './bulk-pack.js';
import type { ConnectionAuth } from './connection.js';
import type { CollectionAuthenticationRequest, CollectionAuthenticationResponse } from './collection-authentication.js';
export * from './collection-authentication.js';
import type { ManagedOAuthMigrationRequest, ManagedOAuthMigrationResponse } from './managed-oauth-migration.js';
export * from './managed-oauth-migration.js';
export const MANAGED_OAUTH_BROKERS = [
  { id: 'nango', label: 'Nango', default_url: 'https://api.nango.dev' },
] as const;
export type ManagedOAuthBroker = (typeof MANAGED_OAUTH_BROKERS)[number]['id'];

export interface ManagedOAuthAuth {
  type: 'managed_oauth';
  broker_profile_id: string;
  integration_id: string;
  connection_id: string;
  /** Pin the vendor destination independently of editable connection config. */
  target_origin: string;
  requested_scopes: readonly string[];
  /** This local connection's needs; never evidence of a vendor grant. */
  required_scopes?: readonly string[];
  /** Attached broker account: its previous per-account scopes are unavailable. */
  imported?: true;
  /** One-time server receipt. Consumed before storing; never persisted. */
  authorization_receipt?: string;
}

export type DirectOAuthAuth = Extract<ConnectionAuth, { type: 'oauth2_refresh' }>;
/** Owner-bound server review. Credentials remain on the server after review. */
export interface DirectOAuthAuthorization {
  type: 'direct_oauth';
  authorization_receipt: string;
  /** Reviewed local needs; not evidence of vendor-granted permissions. */
  requested_scopes: readonly string[];
}
export type AuthenticationSwitchAuthorization = ManagedOAuthAuth | DirectOAuthAuthorization;
export interface DirectOAuthAuthenticationReview {
  auth: DirectOAuthAuthorization;
  expires_at: number;
  required_scopes: readonly string[];
  impact: ManagedOAuthImpactPreview;
  warnings: readonly string[];
}
export const isDirectOAuthAuthenticationReview = (value: unknown): value is DirectOAuthAuthenticationReview => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>; const auth = v.auth as Record<string, unknown> | undefined;
  const scopes = (raw: unknown): boolean => Array.isArray(raw) && raw.length <= 256
    && raw.every(s => typeof s === 'string' && s.length > 0 && s.length <= 2048 && !/[\r\n\0]/.test(s));
  return !!auth && auth.type === 'direct_oauth' && typeof auth.authorization_receipt === 'string'
    && /^[A-Za-z0-9_-]{43}$/.test(auth.authorization_receipt) && scopes(auth.requested_scopes)
    && Number.isSafeInteger(v.expires_at) && Number(v.expires_at) >= 0 && scopes(v.required_scopes)
    && Array.isArray(v.warnings) && v.warnings.every(w => typeof w === 'string') && isManagedOAuthImpactPreview(v.impact)
    && v.impact.target.authentication === 'direct_oauth';
};

export interface ManagedOAuthProfileView {
  id: string;
  label: string;
  broker: ManagedOAuthBroker;
  base_url: string;
  /** Optional self-hosted Connect UI origin, when served separately from the API. */
  connect_ui_origin?: string;
  revision: number;
}

export interface ManagedOAuthIntegration {
  id: string;
  label: string;
  provider: string;
  /** Default requested scopes, not evidence of vendor-granted permissions. */
  default_scopes: readonly string[];
  scope_metadata: 'available' | 'unknown';
}

/** Broker metadata only. Vendor tokens and arbitrary tags never enter the UI. */
export interface ManagedOAuthRemoteConnection {
  id: string;
  label: string;
  auth_error: boolean;
}
/** D-322 §22 — exact local references, never proof of vendor-granted scopes. */
export interface ManagedOAuthConnectionUse {
  kind: 'pack' | 'mail' | 'calendar' | 'file' | 'recipe' | 'dish' | 'schedule';
  id: string;
  label: string;
  may_use?: true;
  paused?: true;
}
export interface ManagedOAuthConnectionUsage {
  name: string;
  display_name: string;
  /** Saved-row revision shown in this read; probes and repair must use this revision. */
  updated_at: number;
  health: {
    status: import('./connection.js').ConnectionHealth['status'];
    last_probed_at?: number;
    /** Allowlisted probe diagnostics; no raw vendor error or payload. */
    http_status?: number;
    permissions_unverified?: true;
  };
  last_used_at?: number;
  uses: readonly ManagedOAuthConnectionUse[];
  usage_available: boolean;
}
export interface ManagedOAuthAccountUsage {
  connection_id: string;
  auth_error: boolean;
  connections: readonly ManagedOAuthConnectionUsage[];
  warnings: readonly string[];
}
/** Mixed-version or interrupted reads must never render as zero healthy dependencies. */
export const isManagedOAuthAccountUsage = (value: unknown): value is ManagedOAuthAccountUsage => {
  const record = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item);
  const date = (item: unknown): boolean => item === undefined
    || typeof item === 'number' && Number.isSafeInteger(item) && item >= 0 && item <= 8_640_000_000_000_000;
  if (!record(value) || typeof value.connection_id !== 'string' || typeof value.auth_error !== 'boolean'
    || !Array.isArray(value.warnings) || !value.warnings.every(warning => typeof warning === 'string')
    || !Array.isArray(value.connections)) return false;
  return value.connections.every(connection => record(connection) && typeof connection.name === 'string'
    && typeof connection.display_name === 'string' && typeof connection.usage_available === 'boolean'
    && typeof connection.updated_at === 'number' && date(connection.updated_at)
    && record(connection.health) && typeof connection.health.status === 'string'
    && ['ok', 'auth_failed', 'unreachable', 'unknown'].includes(connection.health.status)
    && date(connection.health.last_probed_at) && date(connection.last_used_at)
    && (connection.health.http_status === undefined || typeof connection.health.http_status === 'number'
      && Number.isInteger(connection.health.http_status) && connection.health.http_status >= 100 && connection.health.http_status <= 599)
    && (connection.health.permissions_unverified === undefined || connection.health.permissions_unverified === true)
    && Array.isArray(connection.uses) && connection.uses.every(use => record(use)
      && typeof use.kind === 'string' && ['pack', 'mail', 'calendar', 'file', 'recipe', 'dish', 'schedule'].includes(use.kind)
      && typeof use.id === 'string' && typeof use.label === 'string'
      && (use.may_use === undefined || use.may_use === true) && (use.paused === undefined || use.paused === true)));
};
/** D-322 §25 — vendor-reported identity; unavailable identity never adds scopes. */
export interface ManagedOAuthAccountIdentity {
  status: 'known' | 'unknown';
  account_id?: string;
  email?: string;
  display_name?: string;
  user_name?: string;
  reason?: 'not_authorized' | 'unsupported' | 'unavailable';
}
export interface ManagedOAuthAccountPreview {
  authentication: 'direct_oauth' | 'token' | 'broker';
  identity: ManagedOAuthAccountIdentity;
  broker?: ManagedOAuthProfileView;
  integration_id?: string;
  connection_id?: string;
}
export interface ManagedOAuthImpactPreview {
  fingerprint: string;
  phase: 'before_authorization' | 'before_save';
  mode: 'create' | 'reauthorize' | 'switch';
  consent: 'reuse' | 'request';
  current?: ManagedOAuthAccountPreview;
  target: ManagedOAuthAccountPreview;
  connections: readonly {
    name: string; display_name: string;
    effect: 'selected_connection' | 'shared_consent' | 'shares_account';
    uses: readonly ManagedOAuthConnectionUse[];
    usage_available: boolean;
  }[];
  warnings: readonly string[];
  file_source?: import('./file-source-authentication.js').FileSourceAuthenticationPreview;
}
export const isManagedOAuthImpactPreview = (value: unknown): value is ManagedOAuthImpactPreview => {
  const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 2048 && !/[\r\n\0]/.test(v);
  const account = (v: unknown): boolean => {
    if (!record(v) || typeof v.authentication !== 'string' || !['direct_oauth', 'token', 'broker'].includes(v.authentication) || !record(v.identity)) return false;
    const id = v.identity;
    if (typeof id.status !== 'string' || !['known', 'unknown'].includes(id.status)
      || ['account_id', 'email', 'display_name', 'user_name'].some(k => id[k] !== undefined && !text(id[k]))
      || id.status === 'known' && !text(id.account_id)
      || id.status === 'unknown' && ['account_id', 'email', 'display_name', 'user_name'].some(k => id[k] !== undefined)) return false;
    if (v.authentication !== 'broker') return v.broker === undefined && v.connection_id === undefined;
    return (v.broker === undefined || record(v.broker) && text(v.broker.id) && text(v.broker.label) && v.broker.broker === 'nango'
      && text(v.broker.base_url) && Number.isSafeInteger(v.broker.revision))
      && text(v.integration_id) && (v.connection_id === undefined || text(v.connection_id));
  };
  return record(value) && typeof value.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(value.fingerprint)
    && typeof value.phase === 'string' && ['before_authorization', 'before_save'].includes(value.phase)
    && typeof value.mode === 'string' && ['create', 'reauthorize', 'switch'].includes(value.mode)
    && typeof value.consent === 'string' && ['reuse', 'request'].includes(value.consent) && account(value.target)
    && (value.file_source === undefined || isFileSourceAuthenticationPreview(value.file_source))
    && (value.current === undefined || account(value.current)) && Array.isArray(value.warnings) && value.warnings.every(text)
    && Array.isArray(value.connections) && value.connections.length <= 2048
    && value.connections.every(c => record(c) && text(c.name) && text(c.display_name) && typeof c.usage_available === 'boolean'
      && typeof c.effect === 'string' && ['selected_connection', 'shared_consent', 'shares_account'].includes(c.effect)
      && isManagedOAuthAccountUsage({ connection_id: 'checked', auth_error: false, warnings: [], connections: [{
        name: c.name, display_name: c.display_name, updated_at: 0, health: { status: 'unknown' },
        usage_available: c.usage_available, uses: c.uses,
      }] }));
};
export interface ManagedOAuthProvider { id: string; label: string }
export interface ManagedOAuthIntegrationSetup {
  profile_id: string; integration_id: string; provider: string; label: string;
  app: 'shared' | 'custom';
  /** Transient input sent to Nango; never saved in a Recued broker profile. */
  client_id?: string; client_secret?: string; scopes: readonly string[];
}

/** Owner-only explanation of requests. Never evidence of grants or a save receipt. */
export interface ManagedOAuthPermissionPreview {
  fingerprint: string;
  account_impact?: ManagedOAuthImpactPreview;
  decision: 'authorize' | 'reuse' | 'reconnect' | 'blocked';
  scope_metadata: 'available' | 'unknown' | 'fixed';
  required_scopes: readonly string[];
  previous_scopes: readonly string[];
  /** Absent when the broker's scope profile is unavailable. */
  requested_scopes?: readonly string[];
  added_scopes?: readonly string[];
  retained_scopes?: readonly string[];
  /** Requirements/history; fixed or unknown profiles may not request these as individual scopes. */
  sources: readonly {
    kind: 'request' | 'integration' | 'history' | 'connection' | 'pack' | 'grants';
    label: string;
    scopes: readonly string[];
  }[];
  warnings: readonly string[];
  blocked_reason?: string;
}
export interface ManagedOAuthAuthorizationRequest {
  profile_id: string; integration_id: string; base_url: string; vendor?: string;
  scopes: readonly string[]; name?: string; connection_id?: string; force_reauthorization?: boolean;
  /** D-322 §23 — review a replacement while the existing named connection stays saved. */
  switch_authentication?: true;
  /** Verified permission repair keeps the current broker, integration and account. */
  reauthorize_current?: true;
  expected_updated_at?: number;
  /** Opt in to fixed native identity reads using existing access. */
  include_account_impact?: true;
}

export type ManagedOAuthRequest =
  | import('./authentication-access-verification.js').AuthenticationAccessRequest
  | { action: 'authentication_worklist' }
  | ({ action: 'authentication_history' } & import('./authentication-incident-history.js').AuthenticationIncidentHistoryQuery)
  | ({ action: 'authentication_history_export' } & import('./authentication-history-export.js').AuthenticationHistoryExportQuery)
  | import('./collection-oauth-app-switch.js').CollectionOAuthAppSwitchRequest
  | CollectionAuthenticationRequest
  | ManagedOAuthMigrationRequest
  | { action: 'profiles' }
  | { action: 'save_profile'; id?: string; label: string; broker: ManagedOAuthBroker; base_url: string; connect_ui_origin?: string; api_key?: string }
  | { action: 'delete_profile'; id: string }
  | { action: 'integrations'; profile_id: string; vendor?: string; base_url?: string }
  | { action: 'providers'; profile_id: string; vendor?: string; base_url?: string }
  | ({ action: 'create_integration' } & ManagedOAuthIntegrationSetup)
  | { action: 'remote_connections'; profile_id: string; integration_id: string; page?: number }
  | { action: 'account_usage'; profile_id: string; integration_id: string; connection_id: string }
  | { action: 'attach'; profile_id: string; integration_id: string; connection_id: string; base_url: string; scopes?: readonly string[]; vendor?: string }
  | { action: 'delete_remote_connection'; profile_id: string; integration_id: string; connection_id: string; confirmation: string }
  | ({ action: 'preview' } & ManagedOAuthAuthorizationRequest)
  | ({ action: 'start'; preview_fingerprint?: string } & ManagedOAuthAuthorizationRequest)
  | { action: 'account_impact'; flow_id: string; claim_secret: string }
  | { action: 'status'; flow_id: string; claim_secret: string }
  | { action: 'cancel'; flow_id: string; claim_secret: string }
  | { action: 'file_authentication_files'; name: string; expected_updated_at: number; query?: string; after?: string }
  | { action: 'file_authentication_prepare'; name: string; expected_updated_at: number; verification_file_id?: string }
  | { action: 'reauthorization_context'; name: string; expected_updated_at: number }
  | { action: 'review_direct_authentication'; selections: readonly { name: string; expected_updated_at: number }[];
      auth?: DirectOAuthAuth; source_name?: string; scopes?: readonly string[]; oauth_app_id?: string; oauth_app_issuer?: import('./foundational-oauth.js').OAuthAppIssuer }
  | { action: 'retire_direct_authentication'; auth: DirectOAuthAuthorization }
  // D-322 — separately verified consent does not reopen the metadata update RPC.
  | { action: 'save_reauthorization'; name: string; expected_updated_at: number; impact_fingerprint?: string; patch: {
      display_name?: string; config?: Record<string, unknown>; auth: ManagedOAuthAuth;
    } }
  | { action: 'apply_authentication_switch'; attempt_id: string; name: string; expected_updated_at: number;
      auth: AuthenticationSwitchAuthorization; verification_url: string; impact_fingerprint?: string };

export type ManagedOAuthResponse =
  | import('./authentication-access-verification.js').AuthenticationAccessResponse
  | { action: 'authentication_worklist'; worklist: import('./authentication-repair-worklist.js').AuthenticationRepairWorklist }
  | { action: 'authentication_history'; history: import('./authentication-incident-history.js').AuthenticationIncidentHistoryPage }
  | { action: 'authentication_history_export'; report: import('./authentication-history-export.js').AuthenticationHistoryExport }
  | { action: 'file_authentication_files'; choices: import('./file-download-verification.js').FileDownloadChoices }
  | { action: 'file_authentication_prepare'; name: string; updated_at: number; file_source: import('./file-source-authentication.js').FileSourceAuthenticationPreview | null }
  | import('./collection-oauth-app-switch.js').CollectionOAuthAppSwitchResponse
  | { action: 'reauthorization_context'; name: string; updated_at: number; auth_type: 'oauth2_refresh' | 'managed_oauth';
      client_id?: string; token_endpoint?: string; required_scopes?: readonly string[];
      saved_oauth_app?: { issuer: import('./foundational-oauth.js').OAuthAppIssuer; id: string } }
  | CollectionAuthenticationResponse
  | ManagedOAuthMigrationResponse
  | ({ action: 'review_direct_authentication' } & DirectOAuthAuthenticationReview)
  | { action: 'retire_direct_authentication' }
  | { action: 'account_impact'; impact: ManagedOAuthImpactPreview }
  | { action: 'preview'; preview: ManagedOAuthPermissionPreview }
  | { action: 'profiles'; profiles: readonly ManagedOAuthProfileView[] }
  | { action: 'save_profile'; profile: ManagedOAuthProfileView; integrations: readonly ManagedOAuthIntegration[] }
  | { action: 'delete_profile' | 'cancel' }
  | { action: 'integrations'; integrations: readonly ManagedOAuthIntegration[]; selected_id?: string; required_scopes?: readonly string[] }
  | { action: 'providers'; providers: readonly ManagedOAuthProvider[]; selected_id?: string }
  | { action: 'create_integration'; integration: ManagedOAuthIntegration }
  | { action: 'remote_connections'; connections: readonly ManagedOAuthRemoteConnection[]; page: number; has_more: boolean }
  | { action: 'account_usage'; usage: ManagedOAuthAccountUsage }
  | { action: 'attach'; flow_id: string; claim_secret: string; auth: ManagedOAuthAuth; expires_at: number; impact_available?: true }
  | { action: 'delete_remote_connection' }
  | { action: 'start'; flow_id: string; claim_secret: string; connect_link: string; expires_at: number; requested_scopes: readonly string[]; scope_metadata: 'available' | 'unknown' | 'fixed'; impact_available?: true }
  /** Reuse is backed by completed requested-scope history, not grant evidence. */
  | { action: 'reuse'; flow_id: string; claim_secret: string; expires_at: number; auth: ManagedOAuthAuth; granted_scopes?: readonly string[]; impact_available?: true }
  | { action: 'status'; status: 'pending' | 'authorized' | 'expired'; auth?: ManagedOAuthAuth; granted_scopes?: readonly string[]; impact_available?: true }
  | { action: 'save_reauthorization'; connection: import('./connection.js').ConnectionView }
  | { action: 'apply_authentication_switch'; connection: import('./connection.js').ConnectionView;
      verification: import('./connection.js').ConnectionCredentialVerification };

/** A read-only switch check stays inside the saved API service. Sheets links are a convenient input. */
export const managedOAuthVerificationUrl = (baseUrl: string, input: string): string | undefined => {
  if (!input.trim() || input.length > 4096 || /[\r\n\0]/.test(input)) return undefined;
  try {
    const base = new URL(baseUrl); let url = new URL(input.trim());
    if (url.username || url.password) return undefined;
    if (base.hostname === 'sheets.googleapis.com' && url.origin === 'https://docs.google.com') {
      const sheet = /^\/spreadsheets\/d\/([\w-]+)(?:\/|$)/.exec(url.pathname);
      if (!sheet) return undefined;
      url = new URL(`${base.origin}/v4/spreadsheets/${sheet[1]}?fields=spreadsheetId`);
    }
    // Proxies and vendor routers can decode paths differently. Encoded
    // separators or a second encoding must not escape the pinned API prefix.
    if ([base.pathname, url.pathname].some(path => /%(?:2f|5c|25)/i.test(path))) return undefined;
    const path = decodeURIComponent(base.pathname).replace(/\/+$/, '');
    const resourcePath = decodeURIComponent(url.pathname);
    if (url.origin !== base.origin || url.username || url.password || url.hash
      || [...url.searchParams.keys()].some(key => /^(?:access_token|refresh_token|client_secret|api_key|token|authorization)$/i.test(key))
      || /[\r\n\0\\]/.test(resourcePath)
      || (resourcePath !== path && !resourcePath.startsWith(path + '/'))) return undefined;
    return url.toString();
  } catch { return undefined; }
};

/** Minimal identity reads; services needing a resource ID leave the field empty. */
export const managedOAuthDefaultVerificationUrl = (baseUrl: string): string => {
  try {
    const base = new URL(baseUrl); const prefix = base.toString().replace(/\/+$/, '');
    if (base.hostname === 'graph.microsoft.com') return `${prefix}/me?$select=id`;
    if (base.origin === 'https://api.dropboxapi.com') return `${prefix}/2/users/get_current_account`;
    if (base.origin === 'https://api.box.com' && base.pathname.replace(/\/$/, '') === '/2.0') return `${prefix}/users/me`;
    if (base.hostname === 'gmail.googleapis.com') return `${prefix}${base.pathname === '/' ? '/gmail/v1' : ''}/users/me/profile`;
    if (base.hostname === 'www.googleapis.com' && base.pathname.startsWith('/drive')) return `${prefix}/about?fields=user`;
    if (base.origin === 'https://www.googleapis.com' && base.pathname.replace(/\/$/, '') === '/calendar/v3') return `${prefix}/users/me/calendarList?maxResults=1`;
    return '';
  } catch { return ''; }
};

/** Conservative service mapping. Unknown integrations need an explicit owner pick. */
export const managedOAuthProvidersForTarget = (baseUrl: string, vendor?: string): readonly string[] => {
  let url: URL;
  try { url = new URL(baseUrl); } catch { return []; }
  const host = url.hostname.toLowerCase();
  if (host === 'sheets.googleapis.com') return ['google-sheet', 'google-sheets'];
  if (host === 'gmail.googleapis.com') return ['gmail', 'google-mail'];
  if (host === 'www.googleapis.com' && url.pathname.startsWith('/drive')) return ['google-drive'];
  if (host === 'www.googleapis.com' && url.pathname.startsWith('/calendar')) return ['google-calendar'];
  if (host === 'graph.microsoft.com') return ['microsoft', 'microsoft-graph', 'microsoft-tenant-specific', 'microsoft-excel', 'outlook', 'outlook-calendar', 'one-drive', 'one-drive-personal', 'sharepoint-online'];
  if (host === 'api.github.com') return ['github', 'github-app', 'github-app-oauth'];
  if (host === 'api.hubapi.com') return ['hubspot'];
  if (host === 'api.box.com' && url.pathname.replace(/\/$/, '') === '/2.0') return ['box'];
  if (host === 'api.notion.com') return ['notion'];
  if (host === 'slack.com' || host === 'api.slack.com') return ['slack'];
  if (host === 'api.dropboxapi.com' || host === 'content.dropboxapi.com') return ['dropbox'];
  if (host.endsWith('.salesforce.com') && vendor === 'salesforce') return ['salesforce', 'salesforce-sandbox'];
  return [];
};

export const managedOAuthScopeUnion = (...sets: readonly (readonly string[])[]): string[] =>
  [...new Set(sets.flat().map((scope) => scope.trim()).filter(Boolean))].sort();

/** Pack slot names can differ from vendor names. Restrict their union to this API service. */
export const managedOAuthRequiredScopes = (manifests: readonly BulkPackManifest[], vendor: string, baseUrl: string): string[] => {
  let target: URL;
  try { target = new URL(baseUrl); } catch { return []; }
  const sameService = (raw: string, expected: URL): boolean => {
    let service: URL;
    try { service = new URL(raw, expected); } catch { return false; }
    if (service.origin !== expected.origin) return false;
    const providers = managedOAuthProvidersForTarget(expected.href, vendor);
    const others = managedOAuthProvidersForTarget(service.href, vendor);
    const prefix = expected.pathname.replace(/\/$/, '');
    return providers.length > 0 && others.length > 0
      ? providers.some((provider) => others.includes(provider))
      : service.pathname === prefix || service.pathname.startsWith(`${prefix}/`);
  };
  const scopes: string[][] = [];
  for (const manifest of manifests) {
    const services = (manifest.connection_requirements ?? []).flatMap((requirement) => {
      if (requirement.vendor !== vendor) return [];
      let service: URL;
      try { service = new URL(requirement.api_base); } catch { return []; }
      return requirement.per_org === true || sameService(target.href, service) ? [service] : [];
    });
    if (services.length === 0) continue;
    for (const content of manifest.contents ?? []) {
      if (content.type !== 'composition') continue;
      const ingredients = new Set(content.composition.ingredients.filter((ingredient) =>
        ingredient.http?.connection && services.some((service) => sameService(ingredient.http!.base, service)))
        .map((ingredient) => ingredient.slug));
      for (const operation of content.composition.operations) {
        if (ingredients.has(operation.ingredient) && operation.required_scopes !== undefined) scopes.push(operation.required_scopes);
      }
    }
  }
  return managedOAuthScopeUnion(...scopes);
};

/** Attribution uses the same service filter as the authoritative scope union. */
export const managedOAuthPackScopeRequirements = (manifests: readonly BulkPackManifest[], vendor: string, baseUrl: string): {
  slug: string; name: string; scopes: readonly string[];
}[] => manifests.flatMap(manifest => {
  const scopes = managedOAuthRequiredScopes([manifest], vendor, baseUrl);
  return scopes.length === 0 ? [] : [{ slug: manifest.slug, name: manifest.name, scopes }];
});
