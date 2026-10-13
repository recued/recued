/** D-322 — broker setup and authorization. No broker key enters a connection view. */
import type { BulkPackManifest } from './bulk-pack.js';
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
}

export type ManagedOAuthRequest =
  | { action: 'profiles' }
  | { action: 'save_profile'; id?: string; label: string; broker: ManagedOAuthBroker; base_url: string; connect_ui_origin?: string; api_key?: string }
  | { action: 'delete_profile'; id: string }
  | { action: 'integrations'; profile_id: string; vendor?: string; base_url?: string }
  | { action: 'providers'; profile_id: string; vendor?: string; base_url?: string }
  | ({ action: 'create_integration' } & ManagedOAuthIntegrationSetup)
  | { action: 'remote_connections'; profile_id: string; integration_id: string; page?: number }
  | { action: 'attach'; profile_id: string; integration_id: string; connection_id: string; base_url: string; scopes?: readonly string[]; vendor?: string }
  | { action: 'delete_remote_connection'; profile_id: string; integration_id: string; connection_id: string; confirmation: string }
  | ({ action: 'preview' } & ManagedOAuthAuthorizationRequest)
  | ({ action: 'start'; preview_fingerprint?: string } & ManagedOAuthAuthorizationRequest)
  | { action: 'status'; flow_id: string; claim_secret: string }
  | { action: 'cancel'; flow_id: string; claim_secret: string }
  // D-322 — separately verified consent does not reopen the metadata update RPC.
  | { action: 'save_reauthorization'; name: string; expected_updated_at: number; patch: {
      display_name?: string; config?: Record<string, unknown>; auth: ManagedOAuthAuth;
    } };

export type ManagedOAuthResponse =
  | { action: 'preview'; preview: ManagedOAuthPermissionPreview }
  | { action: 'profiles'; profiles: readonly ManagedOAuthProfileView[] }
  | { action: 'save_profile'; profile: ManagedOAuthProfileView; integrations: readonly ManagedOAuthIntegration[] }
  | { action: 'delete_profile' | 'cancel' }
  | { action: 'integrations'; integrations: readonly ManagedOAuthIntegration[]; selected_id?: string; required_scopes?: readonly string[] }
  | { action: 'providers'; providers: readonly ManagedOAuthProvider[]; selected_id?: string }
  | { action: 'create_integration'; integration: ManagedOAuthIntegration }
  | { action: 'remote_connections'; connections: readonly ManagedOAuthRemoteConnection[]; page: number; has_more: boolean }
  | { action: 'attach'; flow_id: string; claim_secret: string; auth: ManagedOAuthAuth; expires_at: number }
  | { action: 'delete_remote_connection' }
  | { action: 'start'; flow_id: string; claim_secret: string; connect_link: string; expires_at: number; requested_scopes: readonly string[]; scope_metadata: 'available' | 'unknown' | 'fixed' }
  /** Reuse is backed by completed requested-scope history, not grant evidence. */
  | { action: 'reuse'; flow_id: string; claim_secret: string; expires_at: number; auth: ManagedOAuthAuth; granted_scopes?: readonly string[] }
  | { action: 'status'; status: 'pending' | 'authorized' | 'expired'; auth?: ManagedOAuthAuth; granted_scopes?: readonly string[] }
  | { action: 'save_reauthorization'; connection: import('./connection.js').ConnectionView };

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
