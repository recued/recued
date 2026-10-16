import { OAUTH_APP_ID, isSavedOAuthApp, type OAuthAppIssuer, type SavedOAuthApp } from './foundational-oauth.js';
import type { ManagedOAuthAccountIdentity } from './managed-oauth.js';
import type { AuthenticationCollectionPlatform, CollectionAuthenticationProvider } from './collection-authentication.js';
import { isCollectionPermissionPreview, type CollectionPermissionChoices, type CollectionPermissionPreview } from './collection-permissions.js';

export interface OAuthAppSwitchCollection {
  platform: AuthenticationCollectionPlatform; slug: string; provider: CollectionAuthenticationProvider;
  current: ManagedOAuthAccountIdentity; required_scopes: readonly string[]; selections: readonly string[];
  permissions?: CollectionPermissionPreview;
}
export interface CollectionOAuthAppContext {
  /** Absent on older servers: an app switch, rather than current-app consent. */
  intent?: 'switch_app' | 'reauthorize';
  id: string; fingerprint: string; expires_at: number;
  platform: AuthenticationCollectionPlatform; slug: string; issuer: OAuthAppIssuer;
  current_app: SavedOAuthApp; apps: readonly SavedOAuthApp[];
  collections: readonly OAuthAppSwitchCollection[]; requested_scopes: readonly string[];
  retained_scopes?: readonly string[]; added_scopes?: readonly string[];
}
export interface CollectionOAuthAppAuthorization {
  id: string; context_id: string; expires_at: number; issuer: OAuthAppIssuer;
  app: SavedOAuthApp; requested_scopes: readonly string[];
}
export interface CollectionOAuthAppReview {
  id: string; fingerprint: string; expires_at: number; context: CollectionOAuthAppContext;
  app: SavedOAuthApp; targets: readonly ManagedOAuthAccountIdentity[]; granted_scopes: readonly string[];
}
export interface CollectionOAuthAppOutcome {
  intent?: 'switch_app' | 'reauthorize';
  attempt_id: string; platform: AuthenticationCollectionPlatform; slug: string;
  status: 'checking' | 'applied' | 'failed'; app_id: string;
  collections: readonly { platform: AuthenticationCollectionPlatform; slug: string }[];
  restart_needed?: readonly { platform: AuthenticationCollectionPlatform; slug: string }[];
  reason?: 'changed' | 'access_failed' | 'interrupted';
}
export type CollectionOAuthAppSwitchRequest =
  | { action: 'collection_authentication_app_context'; platform: AuthenticationCollectionPlatform; slug: string;
      intent?: 'switch_app' | 'reauthorize'; scopes?: readonly string[]; permissions?: readonly CollectionPermissionChoices[] }
  | { action: 'collection_authentication_app_authorize'; context_id: string; fingerprint: string; app_id: string; expected_revision: number }
  | { action: 'collection_authentication_app_review'; authorization_id: string; code: string; redirect_uri: string }
  | { action: 'collection_authentication_app_apply'; review_id: string; fingerprint: string; attempt_id: string }
  | { action: 'collection_authentication_app_status'; attempt_id: string }
  | { action: 'collection_authentication_app_retire'; id: string };
export type CollectionOAuthAppSwitchResponse =
  | { action: 'collection_authentication_app_context'; context: CollectionOAuthAppContext }
  | { action: 'collection_authentication_app_authorize'; authorization: CollectionOAuthAppAuthorization }
  | { action: 'collection_authentication_app_review'; review: CollectionOAuthAppReview }
  | { action: 'collection_authentication_app_apply'; outcome: CollectionOAuthAppOutcome }
  | { action: 'collection_authentication_app_status'; outcome: CollectionOAuthAppOutcome | null }
  | { action: 'collection_authentication_app_retire' };

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const nonce = (v: unknown): boolean => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v);
const fingerprint = (v: unknown): boolean => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const expiry = (v: unknown): boolean => Number.isSafeInteger(v) && Number(v) >= 0;
const strings = (v: unknown): boolean => Array.isArray(v) && v.length <= 256 && v.every(s => typeof s === 'string' && s.length > 0 && s.length <= 4096);
const identity = (v: unknown): v is ManagedOAuthAccountIdentity => record(v) && v.status === 'known'
  && typeof v.account_id === 'string' && v.account_id.length > 0 && v.account_id.length <= 2048
  && (v.email === undefined || typeof v.email === 'string' && v.email.length <= 2048);
const collection = (v: unknown): boolean => record(v) && (v.platform === 'mail' || v.platform === 'calendar')
  && typeof v.slug === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(v.slug);
export const isCollectionOAuthAppContext = (v: unknown): v is CollectionOAuthAppContext => record(v)
  && (v.intent === undefined || v.intent === 'switch_app' || v.intent === 'reauthorize')
  && nonce(v.id) && fingerprint(v.fingerprint) && expiry(v.expires_at) && collection(v)
  && (v.issuer === 'google' || v.issuer === 'microsoft') && isSavedOAuthApp(v.current_app) && v.current_app.issuer === v.issuer
  && Array.isArray(v.apps) && v.apps.length <= 50 && v.apps.every(a => isSavedOAuthApp(a) && a.issuer === v.issuer)
  && Array.isArray(v.collections) && v.collections.length > 0 && v.collections.length <= 16
  && v.collections.every(r => collection(r) && record(r) && ['gmail', 'gcal', 'graph'].includes(String(r.provider))
    && identity(r.current) && strings(r.required_scopes) && strings(r.selections)
    && (r.permissions === undefined || isCollectionPermissionPreview(r.permissions)
      && r.permissions.current.platform === r.platform && r.permissions.current.slug === r.slug)) && strings(v.requested_scopes)
  && (v.retained_scopes === undefined || strings(v.retained_scopes)) && (v.added_scopes === undefined || strings(v.added_scopes));
export const isCollectionOAuthAppAuthorization = (v: unknown): v is CollectionOAuthAppAuthorization => record(v)
  && nonce(v.id) && nonce(v.context_id) && expiry(v.expires_at) && isSavedOAuthApp(v.app) && v.app.issuer === v.issuer && strings(v.requested_scopes);
export const isCollectionOAuthAppReview = (v: unknown): v is CollectionOAuthAppReview => {
  if (!record(v) || !isCollectionOAuthAppContext(v.context)) return false;
  const context = v.context;
  return nonce(v.id) && fingerprint(v.fingerprint) && expiry(v.expires_at)
    && isSavedOAuthApp(v.app) && v.app.issuer === context.issuer && Array.isArray(v.targets)
    && v.targets.length === context.collections.length
    && v.targets.every((target, i) => identity(target) && target.account_id === context.collections[i]!.current.account_id)
    && strings(v.granted_scopes);
};
export const isCollectionOAuthAppOutcome = (v: unknown): v is CollectionOAuthAppOutcome => record(v)
  && (v.intent === undefined || v.intent === 'switch_app' || v.intent === 'reauthorize')
  && nonce(v.attempt_id) && collection(v) && ['checking', 'applied', 'failed'].includes(String(v.status))
  && typeof v.app_id === 'string' && OAUTH_APP_ID.test(v.app_id)
  && Array.isArray(v.collections) && v.collections.length > 0 && v.collections.length <= 16 && v.collections.every(collection)
  && (v.restart_needed === undefined || Array.isArray(v.restart_needed) && v.restart_needed.length <= 16 && v.restart_needed.every(collection))
  && (v.reason === undefined || ['changed', 'access_failed', 'interrupted'].includes(String(v.reason)));
