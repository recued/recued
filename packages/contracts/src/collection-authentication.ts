/** Owner-reviewed authentication changes for an existing Mail or Calendar. */
import type { ManagedOAuthAccountIdentity, ManagedOAuthConnectionUse } from './managed-oauth.js';
import { isCollectionPermissionPreview, type CollectionPermissionChoices, type CollectionPermissionPreview } from './collection-permissions.js';

export type AuthenticationCollectionPlatform = 'mail' | 'calendar';
export type CollectionAuthenticationProvider = 'gmail' | 'gcal' | 'graph';
export interface CollectionAuthenticationSource {
  name: string; display_name: string; authentication: 'direct_oauth' | 'broker';
}
export interface CollectionAuthenticationReview {
  id: string; fingerprint: string; expires_at: number;
  platform: AuthenticationCollectionPlatform; slug: string; provider: CollectionAuthenticationProvider;
  source: CollectionAuthenticationSource;
  current: ManagedOAuthAccountIdentity; target: ManagedOAuthAccountIdentity;
  required_scopes: readonly string[]; granted_scopes?: readonly string[];
  selections: readonly string[]; uses: readonly ManagedOAuthConnectionUse[];
  warnings: readonly string[];
  intent?: 'permissions'; permissions?: CollectionPermissionPreview;
}
export interface CollectionAuthenticationOutcome {
  attempt_id: string; platform: AuthenticationCollectionPlatform; slug: string;
  status: 'checking' | 'applied' | 'failed';
  connection_name: string; authentication: 'direct_oauth' | 'broker';
  intent?: 'permissions';
  applied_at?: number; restart_needed?: true;
  reason?: 'changed' | 'access_failed' | 'unavailable' | 'interrupted';
}
export type CollectionAuthenticationRequest =
  | { action: 'collection_authentication_candidates'; platform: AuthenticationCollectionPlatform; slug: string }
  | { action: 'collection_authentication_review'; platform: AuthenticationCollectionPlatform; slug: string; connection_name: string;
      intent?: 'permissions'; permissions?: CollectionPermissionChoices }
  | { action: 'collection_authentication_apply'; review_id: string; fingerprint: string; attempt_id: string }
  | { action: 'collection_authentication_status'; attempt_id: string }
  | { action: 'collection_authentication_retire'; review_id: string };
export type CollectionAuthenticationResponse =
  | { action: 'collection_authentication_candidates'; sources: readonly CollectionAuthenticationSource[];
      permissions?: CollectionPermissionChoices; provider?: CollectionAuthenticationProvider; current_connection_name?: string }
  | { action: 'collection_authentication_review'; review: CollectionAuthenticationReview }
  | { action: 'collection_authentication_apply'; outcome: CollectionAuthenticationOutcome }
  | { action: 'collection_authentication_status'; outcome: CollectionAuthenticationOutcome | null }
  | { action: 'collection_authentication_retire' };

export const isCollectionAuthenticationReview = (value: unknown): value is CollectionAuthenticationReview => {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const strings = (v: unknown): boolean => Array.isArray(v) && v.length <= 512 && v.every(s => typeof s === 'string' && s.length <= 4096);
  const identity = (v: unknown): boolean => record(v) && v.status === 'known'
    && typeof v.account_id === 'string' && v.account_id.length > 0 && v.account_id.length <= 2048
    && (v.email === undefined || typeof v.email === 'string' && v.email.length <= 2048);
  if (!record(value) || !record(value.source)) return false;
  return typeof value.id === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.id)
    && typeof value.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(value.fingerprint)
    && Number.isSafeInteger(value.expires_at) && Number(value.expires_at) >= 0 && ['mail', 'calendar'].includes(String(value.platform))
    && typeof value.slug === 'string' && ['gmail', 'gcal', 'graph'].includes(String(value.provider))
    && typeof value.source.name === 'string' && typeof value.source.display_name === 'string'
    && ['direct_oauth', 'broker'].includes(String(value.source.authentication))
    && identity(value.current) && identity(value.target)
    && (value.current as Record<string, unknown>).account_id === (value.target as Record<string, unknown>).account_id
    && strings(value.required_scopes)
    && (value.granted_scopes === undefined || strings(value.granted_scopes)) && strings(value.selections)
    && (value.intent === undefined || value.intent === 'permissions')
    && (value.permissions === undefined || isCollectionPermissionPreview(value.permissions)
      && value.permissions.current.platform === value.platform && value.permissions.current.slug === value.slug)
    && strings(value.warnings) && Array.isArray(value.uses) && value.uses.length <= 512
    && value.uses.every(use => record(use) && ['pack', 'mail', 'calendar', 'file', 'recipe', 'dish', 'schedule'].includes(String(use.kind))
      && typeof use.id === 'string' && typeof use.label === 'string');
};
export const isCollectionAuthenticationSource = (value: unknown): value is CollectionAuthenticationSource => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === 'string' && v.name.length > 0 && v.name.length <= 200 && typeof v.display_name === 'string'
    && v.display_name.length <= 4096 && (v.authentication === 'direct_oauth' || v.authentication === 'broker');
};
export const isCollectionAuthenticationOutcome = (value: unknown): value is CollectionAuthenticationOutcome => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.attempt_id === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v.attempt_id)
    && ['mail', 'calendar'].includes(String(v.platform)) && typeof v.slug === 'string' && v.slug.length > 0 && v.slug.length <= 200
    && ['checking', 'applied', 'failed'].includes(String(v.status)) && typeof v.connection_name === 'string'
    && ['direct_oauth', 'broker'].includes(String(v.authentication)) && (v.intent === undefined || v.intent === 'permissions')
    && (v.restart_needed === undefined || v.restart_needed === true)
    && (v.applied_at === undefined || Number.isSafeInteger(v.applied_at) && Number(v.applied_at) >= 0)
    && (v.reason === undefined || ['changed', 'access_failed', 'unavailable', 'interrupted'].includes(String(v.reason)));
};
